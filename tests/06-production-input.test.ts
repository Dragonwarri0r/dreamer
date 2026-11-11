import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ShotData} from '../packages/contracts/storyboard.ts';
import {shotProductionInput,cloudProductionPrompt,missingH3PromptFields,readProductionNotes,updateProductionPrompt,updateImagePrompt,updateProviderPrompt} from '../apps/studio/src/production-input.ts';

const panel=(purpose:'start'|'end'|'reference',description=purpose)=>({id:randomUUID(),title:purpose,purpose,frame:purpose==='end'?123:0,description,artifact:{kind:'artifact' as const,id:randomUUID(),seq:1}});
const nativePrompt='integrated_multimodal_description: [Shot 1] The boy lifts the lid and says: <d>[Chinese]先数一遍。</d>\n\noverall_soundscape: A wooden lid clicks on the table.\n\nnon_diegetic_music: N/A';

test('06 H3 loads full native prompt verbatim and chooses anchored frames, not the first character reference',()=>{
 const reference=panel('reference'),end=panel('end'),start=panel('start');
 const shot=ShotData.parse({title:'问清再做',notes:JSON.stringify({productionPrompt:nativePrompt,motionPrompt:'Legacy motion only.',voice:'临时旁白'}),panels:[reference,end,start]});
 const input=shotProductionInput(shot,'h3');
 assert.equal(input.prompt,nativePrompt);assert.deepEqual(input.referenceIds,[start.artifact.id,end.artifact.id]);assert.deepEqual(input.warnings,[]);assert.deepEqual(missingH3PromptFields(input.prompt),[]);
 assert.equal(shotProductionInput(shot,'ltx').prompt,'Legacy motion only.');assert.equal(shotProductionInput(shot,'tts').prompt,'临时旁白');
});

test('06 an end frame or character reference cannot silently become the opening frame',()=>{
 const shot=ShotData.parse({title:'开场缺帧',notes:JSON.stringify({productionPrompt:nativePrompt}),panels:[panel('reference'),panel('end')]});
 for(const provider of ['h3','ltx']){const input=shotProductionInput(shot,provider);assert.deepEqual(input.referenceIds,[]);assert.ok(input.warnings.some(w=>w.includes('单独尾帧')));}
});

test('06 legacy motion remains editable and H3 never loads narration as a substitute for native audiovisual input',()=>{
 const shot=ShotData.parse({title:'旧镜头',notes:JSON.stringify({productionPrompt:{not:'a string'},motionPrompt:'He lowers the bowl.',voice:'这一天他终于成长了。'}),panels:[panel('start')]});
 const input=shotProductionInput(shot,'h3');assert.equal(input.prompt,'He lowers the bowl.');assert.ok(input.warnings.some(w=>w.includes('不会自动改用 TTS')));assert.equal(missingH3PromptFields(input.prompt).length,3);
});

test('06 malformed notes preserve editable shot action and explicit TTS keeps its independent input',()=>{
 for(const notes of ['ordinary production note','null','[]']){
  const shot=ShotData.parse({title:'可恢复旧稿',notes,action:'He lifts the cup, then puts it down.',sound:'请先等一等。',panels:[panel('reference')]});
  assert.equal(shotProductionInput(shot,'h3').prompt,shot.action);
  assert.equal(shotProductionInput(shot,'tts').prompt,shot.sound);assert.deepEqual(shotProductionInput(shot,'tts').referenceIds,[]);
 }
});

test('06 dedicated prompt edits preserve other structured fields and explicit conversion keeps all plain notes',()=>{
 const raw=JSON.stringify({motionPrompt:'Existing motion.',voice:'保留旧声音',custom:{temperature:2},productionPrompt:'old'});
 const edited=JSON.parse(updateProductionPrompt(raw,nativePrompt));assert.equal(edited.productionPrompt,nativePrompt);assert.equal(edited.voice,'保留旧声音');assert.deepEqual(edited.custom,{temperature:2});assert.equal(edited.motionPrompt,'Existing motion.');
 const plain=' 原始备注\n道具只能出现六只。\n';assert.equal(readProductionNotes(plain).structured,false);const converted=JSON.parse(updateProductionPrompt(plain,nativePrompt));assert.equal(converted.productionNotes,plain);assert.equal(converted.productionPrompt,nativePrompt);
});

test('06 ambiguous start or end anchors are chosen deterministically and disclosed for review',()=>{
 const first=panel('start'),second=panel('start'),end=panel('end');const shot=ShotData.parse({title:'多首帧候选',panels:[first,second,end],notes:JSON.stringify({productionPrompt:nativePrompt})});
 const input=shotProductionInput(shot,'h3');assert.deepEqual(input.referenceIds,[first.artifact.id,end.artifact.id]);assert.ok(input.warnings.some(w=>w.includes('存在多张有效首帧或尾帧')));
});

test('06 image and provider-specific prompts remain separate, preserving native dialogue and anchored references',()=>{
 const start=panel('start'),imagePrompt='脸与掌心清楚，旧布袍保持完整布面，背景以绞盘轮廓辨认。',wan='单镜头5秒。吉皮梯低声说：“还差二十四粒。”口型同步。';
 const shot=ShotData.parse({title:'低纹理密度首帧',panels:[start],notes:JSON.stringify({imagePrompt,productionPrompt:nativePrompt,providerPrompts:{wan},voice:'不要把这句变成配音'})});
 assert.equal(shotProductionInput(shot,'codex-image').prompt,imagePrompt);
 assert.equal(shotProductionInput(shot,'wan').prompt,wan);
 assert.equal(shotProductionInput(shot,'h3').prompt,nativePrompt);
 assert.deepEqual(shotProductionInput(shot,'wan').referenceIds,[start.artifact.id]);
 assert.ok(!shotProductionInput(shot,'wan').prompt.includes(imagePrompt));
 const edited=updateProviderPrompt(updateImagePrompt(shot.notes,'新图片描述'),'wan','新万相对白');
 const saved=ShotData.parse({...shot,notes:edited});
 assert.equal(shotProductionInput(saved,'codex-image').prompt,'新图片描述');
 assert.equal(shotProductionInput(saved,'wan').prompt,'新万相对白');
 assert.equal(shotProductionInput(saved,'h3').prompt,nativePrompt);
 assert.equal(JSON.parse(edited).voice,'不要把这句变成配音');
 const cleared=ShotData.parse({...shot,notes:updateProviderPrompt(updateImagePrompt(shot.notes,''),'wan','')});
 assert.equal(shotProductionInput(cleared,'wan').prompt,'');
 assert.equal(shotProductionInput(cleared,'codex-image').prompt,'');
 assert.equal(shotProductionInput(cleared,'h3').prompt,nativePrompt);
});

test('06 cloud migration removes exact local frame-count boilerplate outside dialogue only',()=>{
 const local='The clip is 124 frames at 24fps; keep the ending naturally alive through the last frame.';
 const converted=cloudProductionPrompt(`${local} <d>[Chinese]${local}</d> The clip is 50 frames at 25fps; keep the ending naturally alive through the last frame.`);
 assert.ok(converted.startsWith('Keep the ending naturally alive through the last frame.'));
 assert.ok(converted.includes(`中文对白：“${local}”`));
 assert.ok(converted.includes('50 frames at 25fps'));
});

test('06 a planned but missing first frame is disclosed without pretending a reference is attached',()=>{
 const shot=ShotData.parse({title:'未生成首帧',notes:JSON.stringify({providerPrompts:{wan:'沿首帧继续一个动作。'},firstFramePlan:{requiresBeforeGeneration:true}}),panels:[{id:randomUUID(),title:'计划首帧',purpose:'start',frame:0,description:'只写起态。'}]});
 const input=shotProductionInput(shot,'wan');assert.deepEqual(input.referenceIds,[]);assert.ok(input.warnings.some(w=>w.includes('实际首帧尚未绑定')));
 assert.equal(input.prompt,'沿首帧继续一个动作。');
 const withFrame=ShotData.parse({...shot,panels:[panel('start')]});assert.ok(!shotProductionInput(withFrame,'wan').warnings.some(w=>w.includes('尚未绑定')));
});
