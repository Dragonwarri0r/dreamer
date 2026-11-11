import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveAgentModelConfig} from '../packages/infra/agent/model-config.ts';
import {AppServerSession} from '../packages/infra/agent/app-server.ts';

function configFixture(text?:string){const root=mkdtempSync(join(tmpdir(),'dreamer-model-config-'));if(text!==undefined)writeFileSync(join(root,'config.toml'),text);return {root,close:()=>rmSync(root,{recursive:true,force:true})};}

test('03 模型继承只读取 TOML 顶层白名单，不把 profile、权限或多行文本当配置',()=>{
 const x=configFixture(`model = 'gpt-6-astra' # 用户选择\nmodel_reasoning_effort = "xhigh"\napi_key = "secret-sentinel"\nbase_instructions = '''\nmodel = "embedded-model"\n'''\n[profiles.other]\nmodel = "profile-model"\nmodel_reasoning_effort = "low"\n[features]\nshell_tool = true\n`);
 try{assert.deepEqual(resolveAgentModelConfig({}, {},x.root),{model:'gpt-6-astra',reasoningEffort:'xhigh',sources:{model:'codex-config',reasoningEffort:'codex-config'}});}finally{x.close();}
});

test('03 实验参数优先于环境覆盖，未覆盖字段才继承用户配置',()=>{
 const x=configFixture('model = "file-model"\nmodel_reasoning_effort = "medium"\n');
 try{
  assert.deepEqual(resolveAgentModelConfig({model:'scoped-model'},{DREAMER_AGENT_MODEL:'env-model',DREAMER_AGENT_REASONING_EFFORT:'high'},x.root),{model:'scoped-model',reasoningEffort:'high',sources:{model:'options',reasoningEffort:'environment'}});
  assert.deepEqual(resolveAgentModelConfig({reasoningEffort:'xhigh'},{DREAMER_AGENT_MODEL:'env-model'},x.root),{model:'env-model',reasoningEffort:'xhigh',sources:{model:'environment',reasoningEffort:'options'}});
  assert.equal(resolveAgentModelConfig({model:'scoped-model'}, {},x.root).reasoningEffort,'medium');
  assert.throws(()=>resolveAgentModelConfig({model:''},{DREAMER_AGENT_MODEL:'env-model'},x.root),/模型必须是非空名称/);
 }finally{x.close();}
});

test('03 缺省模型保持可辨识；配置错误不泄露源文本且完整显式配置可绕过无关配置',()=>{
 const x=configFixture();
 try{
  assert.deepEqual(resolveAgentModelConfig({}, {},x.root),{sources:{model:'provider-default',reasoningEffort:'provider-default'}});
  writeFileSync(join(x.root,'config.toml'),'api_key = "secret-sentinel');
  assert.throws(()=>resolveAgentModelConfig({}, {},x.root),(error:unknown)=>error instanceof Error&&/无法读取/.test(error.message)&&!error.message.includes('secret-sentinel'));
  assert.deepEqual(resolveAgentModelConfig({model:'scoped-model',reasoningEffort:'future-effort'}, {},x.root),{model:'scoped-model',reasoningEffort:'future-effort',sources:{model:'options',reasoningEffort:'options'}});
  writeFileSync(join(x.root,'config.toml'),'model = 123');
  assert.throws(()=>resolveAgentModelConfig({}, {},x.root),/模型必须是非空名称/);
 }finally{x.close();}
});

function fakeServer(override:Record<string,unknown>={}){
 const x=configFixture('model = "inherited-model"\nmodel_reasoning_effort = "xhigh"\napi_key = "secret-sentinel"\n'),binary=join(x.root,'codex-fixture');
 const root=join(x.root,'workspace');mkdirSync(root);
 const requestPath=join(x.root,'requests.jsonl');
 writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});\nconst send=x=>process.stdout.write(JSON.stringify(x)+'\\n');\nrl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requestPath)},JSON.stringify(m)+'\\n');if(m.id===undefined)return;let result={};if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:m.params.threadId||'thread-fixture'},model:m.params.model||'provider-default-model',modelProvider:'openai',reasoningEffort:m.params.config?.model_reasoning_effort||'medium',...${JSON.stringify(override)}};if(m.method==='turn/start'){result={turn:{id:'turn-fixture',status:'inProgress'}};setTimeout(()=>send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-fixture',status:'completed'}}}),15);}send({id:m.id,result});});\n`,{mode:0o700});
 const keys=['DREAMER_CODEX_BIN','CODEX_HOME','DREAMER_AGENT_MODEL','DREAMER_AGENT_REASONING_EFFORT'] as const,prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.DREAMER_CODEX_BIN=binary;process.env.CODEX_HOME=x.root;delete process.env.DREAMER_AGENT_MODEL;delete process.env.DREAMER_AGENT_REASONING_EFFORT;
 return {root,requests:()=>readFileSync(requestPath,'utf8').trim().split('\n').map(l=>JSON.parse(l)),close(){for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}x.close();}};
}

test('03 App Server 实际请求在创建、恢复和轮次都使用已确认模型，证据不保存提示词或源配置',{timeout:5000},async()=>{
 const x=fakeServer();const session=new AppServerSession(x.root,{model:'scoped-model',reasoningEffort:'high'});
 try{
  const id=await session.start(undefined,[],'private instructions');assert.equal(id,'thread-fixture');
  await session.start(id,[],'private resumed instructions');
  let completed!:()=>void;const done=new Promise<void>(resolve=>completed=resolve);
  await session.turn(id,'private prompt',event=>{if(event.type==='complete')completed();},async()=>({}));await done;
  const requests=x.requests(),start=requests.find(r=>r.method==='thread/start'),resume=requests.find(r=>r.method==='thread/resume'),turn=requests.find(r=>r.method==='turn/start');
  for(const r of [start,resume]){assert.equal(r.params.model,'scoped-model');assert.deepEqual(r.params.config,{model_reasoning_effort:'high'});assert.equal(r.params.effort,undefined);assert.equal(r.params.approvalPolicy,'never');assert.equal(r.params.sandbox,'read-only');}
  assert.equal(start.params.allowProviderModelFallback,false);assert.equal(resume.params.threadId,id);assert.equal(resume.params.dynamicTools,undefined);
  assert.equal(turn.params.model,'scoped-model');assert.equal(turn.params.effort,'high');assert.equal(turn.params.config,undefined);
  const raw=readFileSync(session.evidencePath,'utf8'),evidence=raw.trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(evidence.filter(e=>e.event==='thread-configured').length,2);assert.equal(evidence.find(e=>e.event==='thread-configured').confirmed.reasoningEffort,'high');assert.equal(evidence.at(-1).status,'completed');
  assert.ok(!raw.includes('private'));assert.ok(!raw.includes('secret-sentinel'));assert.ok(!raw.includes('api_key'));assert.ok(!existsSync(join(x.root,'runtime','codex','config.toml')));assert.equal(statSync(session.evidencePath).mode&0o777,0o600);
 }finally{session.close();x.close();}
});

test('03 App Server 拒绝静默模型替换或推理强度丢失，不能在未确认配置后启动轮次',{timeout:5000},async()=>{
 for(const override of [{model:'unexpected-model'},{reasoningEffort:null}]){
  const x=fakeServer(override),session=new AppServerSession(x.root);
  try{await assert.rejects(session.start(undefined,[],'test'),/与请求不一致/);await assert.rejects(session.turn('thread-fixture','test',()=>{},async()=>({})),/先确认会话模型配置/);assert.ok(!x.requests().some(r=>r.method==='turn/start'));assert.equal(JSON.parse(readFileSync(session.evidencePath,'utf8').trim().split('\n').at(-1)!).matches,false);}finally{session.close();x.close();}
 }
});

test('03 图片模式不读取文本 Agent 环境或配置，仍允许显式构造参数',{timeout:5000},async()=>{
 const x=fakeServer();
 process.env.DREAMER_AGENT_MODEL='invalid text model';process.env.DREAMER_AGENT_REASONING_EFFORT='invalid text effort';
 writeFileSync(join(x.root,'..','config.toml'),'api_key = "broken-secret-sentinel');
 try{
  for(const options of [{imageMode:true},{imageMode:true,model:'image-model',reasoningEffort:'high'}]){
   const session=new AppServerSession(x.root,options);
   try{
    assert.deepEqual(session.modelConfig,options.model?{model:'image-model',reasoningEffort:'high',sources:{model:'options',reasoningEffort:'options'}}:{sources:{model:'provider-default',reasoningEffort:'provider-default'}});
    await session.start(undefined,[],'image task');
    const request=x.requests().filter(r=>r.method==='thread/start').at(-1);
    assert.equal(request.params.model,options.model);assert.deepEqual(request.params.config,options.model?{model_reasoning_effort:'high'}:undefined);
   }finally{session.close();}
  }
 }finally{x.close();}
});
