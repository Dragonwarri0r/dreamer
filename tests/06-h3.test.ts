import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,until} from './helpers.ts';
import {RenderIntent,type Capability,type MediaProvider} from '../packages/contracts/production.ts';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import type {AgentSession} from '../packages/core/agent/port.ts';
import h3Profiles from '../packages/contracts/h3-profiles.json' with {type:'json'};
import {execute,mediaBinary} from '../packages/infra/media.ts';
const intent={provider:'h3',profile:'h3-quality/v1',prompt:'A woman turns her head.',quality:'final',constraints:{width:480,height:832,durationSeconds:124/24,fps:24,audio:true}};
const cap:Capability={id:'h3',title:'H3 contract fixture',available:true,detail:'test',profiles:Object.keys(h3Profiles),fingerprint:'test',cost:'local',concurrencyGroup:'local-video',supports:{references:true,lastFrame:true,audio:true,final:true}};
function provider(overrides:Partial<MediaProvider>={}):MediaProvider{return {describe:()=>cap,async submit(){return {state:'failed',error:'H3 内存预检未通过',metrics:{errorCode:'MEMORY_PREFLIGHT'}};},async status(){return {state:'failed'};},async cancel(){},...overrides};}
test('06 低分辨率原生音画预览明确选择，不接受final目标或静默沿用正式画幅',()=>{
 const x=fixture({providers:[provider()]});try{
  const preview={...intent,profile:'h3-preview/v1',quality:'draft',constraints:{...intent.constraints,width:320,height:576}};
  const p=x.app.production.capabilities().find(c=>c.id==='h3')!.profileConstraints!['h3-preview/v1'];
  assert.equal(p.audio,true);assert.equal(p.final,false);assert.equal(p.frames,124);
  assert.doesNotThrow(()=>x.app.production.validate(x.pid,RenderIntent.parse(preview)));
  assert.throws(()=>x.app.production.validate(x.pid,RenderIntent.parse({...preview,quality:'final'})),/Turbo/);
  assert.throws(()=>x.app.production.validate(x.pid,RenderIntent.parse({...preview,constraints:intent.constraints})),/320×576/);
  assert.throws(()=>x.app.production.validate(x.pid,RenderIntent.parse({...preview,constraints:{...preview.constraints,audio:false}})),/原生音频/);
  assert.equal(x.app.production.jobs.list(x.pid).length,0);
 }finally{x.close();}
});
test('06 H3 固定规格、原生音频、Turbo 预览与预算不能被静默降级',async()=>{
 const x=fixture({providers:[provider()]});try{
  assert.throws(()=>x.run('job.submit',{...intent,constraints:{...intent.constraints,width:512}}),/480/);
  assert.throws(()=>x.run('job.submit',{...intent,constraints:{...intent.constraints,audio:false}}),/原生音频/);
  assert.throws(()=>x.run('job.submit',{...intent,profile:'h3-turbo/v1'}),/Turbo/);
  assert.throws(()=>x.run('job.submit',{...intent,prompt:' \n\t'}),/非空/);
  const project=x.app.projects.repo.get(x.pid,x.pid);x.run('project.update',{id:x.pid,expectedSeq:project.seq,data:{...project.data,generationLimit:1}});
  const j=x.run('job.submit',intent);
  const done=await until(()=>x.app.production.jobs.get(j.id,x.pid),v=>v.data.state==='failed');
  assert.equal(done.data.metrics.errorCode,'MEMORY_PREFLIGHT');
  assert.throws(()=>x.run('job.submit',intent),/预算/);
 }finally{x.close();}
});
test('06 H3 中文对白与旧提示词原样派发，拒绝无效 Unicode 和超长输入',async()=>{
 let received='';const x=fixture({providers:[provider({async submit(request){received=request.intent.prompt;return {state:'failed',error:'contract-only'};}})]});try{
  const prompt='integrated_multimodal_description: [Shot 1] Jipiti (S1) says: <d>[Chinese]别急，先数清楚。</d>\noverall_soundscape: Steam hisses.\nnon_diegetic_music: N/A';
  const job=x.run('job.submit',{...intent,prompt});await until(()=>x.app.production.jobs.get(job.id,x.pid),v=>v.data.state==='failed');
  assert.equal(received,prompt);assert.equal(x.app.production.jobs.get(job.id,x.pid).data.intent.prompt,prompt);
  for(const invalid of ['', '\t\n ', '\ud800', '\udc00', '甲'.repeat(4001)])assert.throws(()=>x.app.production.validate(x.pid,RenderIntent.parse({...intent,prompt:invalid})),/非空有效 Unicode/);
  for(const valid of [intent.prompt,'角色转头，然后说：你好。','🪶'.repeat(4000)])assert.doesNotThrow(()=>x.app.production.validate(x.pid,RenderIntent.parse({...intent,prompt:valid})));
 }finally{x.close();}
});
test('06 Agent 可查询实时视频 Profile 约束，查询不授予生成权限',async()=>{
 let available=true,tool:Parameters<AgentSession['turn']>[3]|undefined;
 const ltx:MediaProvider={describe:()=>({...cap,id:'ltx',profiles:['ltx-mps-sample/v1','ltx-mps-i2v-story/v1'],supports:{references:true,lastFrame:true,audio:false,final:false}}),async submit(){throw new Error('查询不得执行生成');},async status(){return {state:'unknown'};},async cancel(){}};
 const x=fixture({providers:[provider({describe:()=>({...cap,available})}),ltx],agentFactory:()=>({async start(){return 'fixture';},async turn(_id,_text,_event,onTool){tool=onTool;return 'fixture-turn';},async interrupt(){},close(){}})});try{
  const thread=x.run('thread.create',{title:'读取制作规格'}),owner=randomUUID();x.run('thread.claim',{id:thread.id,expectedSeq:thread.seq,owner});x.run('thread.send',{id:thread.id,owner,text:'先读取视频能力'});await until(()=>tool,Boolean);
  const discovery=await tool!('dreamer_skills',{},'capabilities') as any;
  assert.deepEqual(discovery.capabilities,x.app.production.capabilities());
  const h3=discovery.capabilities.find((c:any)=>c.id==='h3'),profile=h3.profileConstraints['h3-quality/v1'],fixed=h3Profiles['h3-quality/v1'];
  assert.equal(profile.frames,fixed.frames);assert.equal(profile.durationSeconds,fixed.frames/fixed.fps);assert.equal(profile.audio,true);assert.equal(profile.promptEncoding,'unicode');assert.equal(profile.maxReferences,2);
  assert.doesNotThrow(()=>x.app.production.validate(x.pid,RenderIntent.parse({...intent,constraints:{width:profile.width,height:profile.height,fps:profile.fps,durationSeconds:profile.durationSeconds,audio:profile.audio}})));
  const silent=discovery.capabilities.find((c:any)=>c.id==='ltx').profileConstraints['ltx-mps-i2v-story/v1'];assert.equal(silent.audio,false);assert.equal(silent.frames,129);assert.equal(silent.minReferences,1);
  await assert.rejects(tool!('job_submit',intent,'forbidden'),/未授权/);assert.equal(x.app.production.jobs.list(x.pid).length,0);
  available=false;const refreshed=await tool!('dreamer_skills',{},'refresh') as any;assert.equal(refreshed.capabilities.find((c:any)=>c.id==='h3').available,false);
 }finally{x.close();}
});
test('06 H3 与 LTX 共用执行槽；未知结果阻止跨模型重提',async()=>{
 let h3Submits=0;
 const ltx:MediaProvider={describe:()=>({...cap,id:'ltx',profiles:['ltx-mps-sample/v1'],supports:{references:true,lastFrame:true,audio:false,final:false}}),async submit(){return {state:'unknown'};},async status(){return {state:'unknown'};},async cancel(){}};
 const x=fixture({providers:[ltx,provider({async submit(){h3Submits++;return {state:'running'};}})]});try{
  const a=x.run('job.submit',{...intent,provider:'ltx',profile:'ltx-mps-sample/v1',quality:'draft',constraints:{width:288,height:512,fps:16,durationSeconds:49/16}});
  await until(()=>x.app.production.jobs.get(a.id,x.pid),v=>v.data.state==='unknown');
  const b=x.run('job.submit',intent);await x.app.production.dispatch(b.id,x.pid);
  assert.equal(h3Submits,0);assert.equal(x.app.production.jobs.get(b.id,x.pid).data.state,'queued');
  x.run('job.cancel',{id:b.id});assert.equal(x.app.production.jobs.get(b.id,x.pid).data.state,'cancelled');
 }finally{x.close();}
});
test('06 H3 原声与画面一起归档，新建剪辑包含独立原声且重复对账不重复登记',async()=>{
 let output='',audio='';
 const x=fixture({providers:[provider({async submit(){return {state:'completed',path:output,nativeAudio:{path:audio,sha256:createHash('sha256').update(readFileSync(audio)).digest('hex')}};}})]});
 try{
  output=join(x.root,'video.mp4');audio=join(x.root,'native.wav');
  await execute(mediaBinary('ffmpeg'),['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=24','-t','1','-c:v','libx264','-pix_fmt','yuv420p',output]);
  await execute(mediaBinary('ffmpeg'),['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1',audio]);
  const shot=x.run('shot.create',{title:'音画候选',durationFrames:24}),target=x.run('shot.checkpoint',{id:shot.id,expectedSeq:shot.seq});
  const job=x.run('job.submit',{...intent,target});
  const done=await until(()=>x.app.production.jobs.get(job.id,x.pid),v=>v.data.state==='completed');
  const video=x.app.production.artifacts.at(done.data.artifact!,x.pid);
  assert.deepEqual(video.data.metadata.nativeAudio,done.data.nativeAudio);
  assert.equal(x.app.production.artifacts.at(done.data.nativeAudio!,x.pid).data.mediaType,'audio/wav');
  await x.app.production.reconcile(job.id,x.pid);
  assert.equal(x.app.production.artifacts.list(x.pid).length,2);
  const candidate=x.app.storyboard.repo.get(shot.id,x.pid);
  x.run('shot.adopt',{id:shot.id,expectedSeq:candidate.seq,takeId:candidate.data.takes[0].id});
  const cut=x.run('cut.fromBoard',{title:'保留原声'});
  assert.equal(cut.data.clips.length,2);
  assert.equal(cut.data.clips[1].artifact.id,done.data.nativeAudio!.id);
  assert.equal(cut.data.clips[1].durationFrames,24);
  const build=x.run('build.create',{id:cut.id,expectedSeq:cut.seq,title:'原声快照'});
  assert.equal(build.data.artifacts.length,2);
 }finally{x.close();}
});
