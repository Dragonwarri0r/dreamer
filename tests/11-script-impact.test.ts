import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cityGateFixture } from './fixtures/interactive-script.ts';
import { ScriptRelease } from '../packages/contracts/experience.ts';
import { scriptReleaseImpact } from '../packages/core/story/impact.ts';
import type { Ref } from '../packages/contracts/foundation.ts';

function fixture(){
 const f=cityGateFixture(),pid=randomUUID(),now=new Date().toISOString();
 const scene={title:'作者场景',blocks:[{id:randomUUID(),type:'dialogue',text:'原有对白',speaker:'守卫'},{id:randomUUID(),type:'action',text:'原有动作',speaker:''}],location:'城门'};
 const release=ScriptRelease.parse({id:randomUUID(),projectId:pid,scriptRef:{kind:'script',id:randomUUID(),seq:1},schemaVersion:1,kind:'playback',manifestHash:'a'.repeat(64),snapshot:f.plan,dependencyRefs:[f.refs.chapter,f.refs.scene],policy:f.plan.policy,activityVersions:[{type:'choice',version:1}],createdAt:now,publishedAt:now});
 const row=(ref:Ref,data:any,seq=ref.seq)=>({id:ref.id,projectId:pid,seq,data,updatedAt:now});
 const read=(ref:Ref)=>row(ref,ref.kind==='scene'?scene:{title:'来源章节',body:'章节正文'});
 return {...f,pid,scene,release,row,read,compare:(plan=f.plan,latest=read)=>scriptReleaseImpact(release,plan,read,latest,pid)};
}

test('11 impact distinguishes metadata, variables, rules and text without mutating a frozen release',()=>{
 const f=fixture(),original=JSON.stringify(f.release);
 let plan=structuredClone(f.plan);plan.title='名称修订';plan.nodes[0].title='节点名称修订';
 assert.deepEqual([...new Set(f.compare(plan).items.map(item=>item.type))],['metadata']);assert.ok(f.compare(plan).items.every(item=>!item.regenerate));
 plan=structuredClone(f.plan);const trust=plan.variables.find(v=>v.key==='trust')!;if(trust.type==='integer')trust.max=5;
 const variables=f.compare(plan).items.filter(item=>item.type==='variable');assert.equal(variables.length,1);assert.ok(variables[0].nodeIds.includes(f.ids.rescue));assert.ok(variables[0].nodeIds.includes(f.ids.result));assert.deepEqual(variables[0].variableKeys,['trust']);
 plan=structuredClone(f.plan);const branch=plan.nodes.find(n=>n.id===f.ids.branch)!;if(branch.type==='branch')branch.cases[0].priority=30;
 assert.ok(f.compare(plan).items.some(item=>item.type==='rule'&&item.nodeIds.includes(f.ids.branch)));
 plan=structuredClone(f.plan);const ending=plan.nodes.find(n=>n.id===f.ids.enter)!;if(ending.type==='ending')ending.summary='新的结局正文';
 assert.ok(f.compare(plan).items.some(item=>item.type==='text'&&item.regenerate));assert.equal(JSON.stringify(f.release),original);
});

test('11 source dialogue and visual changes link affected nodes, fixed versions and separate remake instructions',()=>{
 const f=fixture();
 const latest=(ref:Ref)=>ref.kind==='scene'?f.row(ref,{...f.scene,blocks:f.scene.blocks.map((block,index)=>index===0?{...block,text:'新的对白'}:block),location:'城门内'},2):f.read(ref);
 const result=f.compare(f.plan,latest);assert.equal(result.release.changed,true);assert.equal(result.release.scriptChanged,false);
 assert.deepEqual(new Set(result.release.categories),new Set(['text','audio','visual']));
 assert.equal(result.release.changedDependencies[0].before.seq,1);assert.equal(result.release.changedDependencies[0].current?.seq,2);
 for(const item of result.items){assert.equal(item.sourceRef?.id,f.refs.scene.id);assert.ok(item.nodeIds.includes(f.ids.intro));assert.ok(item.nodeIds.includes(f.ids.rescue));assert.ok(item.message.includes('旧发布'));}
 assert.ok(result.items.find(item=>item.type==='audio')!.message.includes('原生音轨'));
 assert.ok(result.items.find(item=>item.type==='visual')!.message.includes('受影响镜头'));
 const metadata=f.compare(f.plan,ref=>ref.kind==='scene'?f.row(ref,{...f.scene,title:'重命名'},2):f.read(ref));assert.deepEqual(metadata.release.categories,['metadata']);assert.equal(metadata.items[0].regenerate,false);
});

test('11 transitive dependency changes reach the segment through its fixed build',()=>{
 const f=fixture(),plan=structuredClone(f.plan),artifact:Ref={kind:'artifact',id:randomUUID(),seq:1};
 const node=plan.nodes.find(n=>n.id===f.ids.intro)!;if(node.type==='segment')node.contentSpec={mode:'fixed',media:f.media};
 const release={...f.release,snapshot:plan,dependencyRefs:[f.refs.build,artifact]};
 const read=(ref:Ref)=>ref.kind==='build'?f.row(ref,{title:'固定成片',output:artifact}):ref.kind==='artifact'?f.row(ref,{title:'原声视频',mediaType:'video/mp4',sha256:'a'.repeat(64)}):f.read(ref);
 const latest=(ref:Ref)=>ref.kind==='artifact'?f.row(ref,{...read(ref).data,sha256:'b'.repeat(64)},2):read(ref);
 const impact=scriptReleaseImpact(release,plan,read,latest,f.pid);
 assert.deepEqual(new Set(impact.release.categories),new Set(['audio','visual']));assert.ok(impact.release.affectedNodeIds.includes(f.ids.intro));assert.ok(impact.items.every(item=>item.sourceRef?.id===artifact.id));
});
