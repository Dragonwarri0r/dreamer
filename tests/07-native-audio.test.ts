import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {fixture,until} from './helpers.ts';
import {Clip,CutData,cutDuration,insertCutClip,copyCutClip,updateCutClip,removeCutClip} from '../packages/contracts/editorial.ts';
import {ArtifactData} from '../packages/contracts/production.ts';
import type {Ref} from '../packages/contracts/foundation.ts';
import {execute,mediaBinary} from '../packages/infra/media.ts';

function media(x:ReturnType<typeof fixture>,type:'video/mp4'|'audio/wav',seconds:number,nativeAudio?:Ref,fps=24){
 return x.app.production.registerArtifact(x.pid,ArtifactData.parse({title:type,sha256:createHash('sha256').update(randomUUID()).digest('hex'),sizeBytes:100,mediaType:type,durationSeconds:seconds,fps,source:'isolated fixture',createdAt:new Date().toISOString(),metadata:nativeAudio?{nativeAudio}:{}}));
}
function adopted(x:ReturnType<typeof fixture>,artifact:Ref,seconds=2){
 const shot=x.run('shot.create',{title:'画面 A',durationFrames:seconds*24}),input=x.run('shot.checkpoint',{id:shot.id,expectedSeq:shot.seq}),take=x.run('shot.take',{id:shot.id,input,artifact}),current=x.app.storyboard.repo.get(shot.id,x.pid);
 x.run('shot.adopt',{id:shot.id,expectedSeq:current.seq,takeId:take.id});return shot;
}
const read=(x:ReturnType<typeof fixture>)=>(ref:Ref)=>x.app.production.artifacts.at(ref,x.pid).data;

test('07 原声关联随画面替换、移动和按秒换帧率，独立声音与历史 Build 保留',()=>{
 const x=fixture();try{
  const oldAudio=media(x,'audio/wav',6),oldVideo=media(x,'video/mp4',6,oldAudio,16),newAudio=media(x,'audio/wav',6),newVideo=media(x,'video/mp4',6,newAudio,24);
  adopted(x,oldVideo);let cut=x.run('cut.fromBoard',{title:'音画关联'});const picture=cut.data.clips[0];const linked=cut.data.clips.find((c:any)=>c.linkedVideoClipId===picture.id);
  assert.equal(linked.artifact.id,oldAudio.id);assert.equal(linked.sourceFps,16);
  const independent=JSON.parse(JSON.stringify(Clip.parse({...linked,id:randomUUID(),trackId:cut.data.tracks[1].id,title:'用户独立对白',linkedVideoClipId:undefined})));
  cut=x.run('cut.update',{id:cut.id,expectedSeq:cut.seq,data:{...cut.data,clips:[...cut.data.clips,independent]}});
  const fixed=x.run('build.create',{id:cut.id,expectedSeq:cut.seq,title:'旧版原声'});
  let updated=updateCutClip(cut.data,picture.id,{atFrame:24,durationFrames:36,sourceInFrame:16},read(x),randomUUID);
  updated=updateCutClip(updated,picture.id,{artifact:newVideo,shot:undefined,takeId:undefined,sourceFps:24},read(x),randomUUID);
  cut=x.run('cut.update',{id:cut.id,expectedSeq:cut.seq,data:updated});
  const video=cut.data.clips.find((c:any)=>c.id===picture.id),sound=cut.data.clips.find((c:any)=>c.linkedVideoClipId===picture.id);
  assert.equal(video.sourceInFrame,24);assert.equal(sound.sourceInFrame,24);assert.equal(sound.sourceFps,24);assert.equal(sound.atFrame,24);assert.equal(sound.durationFrames,36);assert.equal(sound.artifact.id,newAudio.id);assert.equal(sound.id,linked.id);
  assert.deepEqual(cut.data.clips.find((c:any)=>c.id===independent.id),independent);
  assert.equal(x.app.editorial.builds.get(fixed.id,x.pid).data.snapshot.clips.find(c=>c.id===linked.id)!.artifact!.id,oldAudio.id);
  const removed=removeCutClip(cut.data,picture.id,read(x));assert.deepEqual(removed.clips,[independent]);
 }finally{x.close();}
});

test('07 插入视频带原声，旧剪辑仅通过明确来源识别原声，不猜删独立声音',()=>{
 const x=fixture();try{
  const audio=media(x,'audio/wav',6),video=media(x,'video/mp4',6,audio),silent=media(x,'video/mp4',6);
  const track=randomUUID(),music=randomUUID();const empty=CutData.parse({title:'插入',tracks:[{id:track,title:'画面',type:'video'},{id:music,title:'独立配乐',type:'music'}]});
  const picture=Clip.parse({id:randomUUID(),title:'插入视频',trackId:track,artifact:video,atFrame:0,durationFrames:48});
  const inserted=insertCutClip(empty,picture,read(x),randomUUID),native=inserted.clips.find(c=>c.linkedVideoClipId===picture.id)!;
  const separate={...native,id:randomUUID(),trackId:music,linkedVideoClipId:undefined};
  const legacy={...inserted,clips:[picture,{...native,linkedVideoClipId:undefined},separate]};const snapshot=structuredClone(legacy);
  const replaced=updateCutClip(legacy,picture.id,{artifact:silent},read(x),randomUUID);
  assert.equal(replaced.clips.length,2);assert.ok(replaced.clips.some(c=>c.id===separate.id));assert.ok(!replaced.clips.some(c=>c.id===native.id));assert.deepEqual(legacy,snapshot);
  assert.deepEqual(removeCutClip(legacy,picture.id,read(x)).clips,[separate]);
  const movedLegacy={...legacy,clips:legacy.clips.map(c=>c.id===native.id?{...c,atFrame:1}:c)};
  assert.throws(()=>updateCutClip(movedLegacy,picture.id,{artifact:silent},read(x),randomUUID),/旧原声与画面裁切已不一致/);
  const noMetadata={...legacy,clips:legacy.clips.map(c=>c.id===picture.id?{...c,artifact:silent}:c)};
  assert.equal(removeCutClip(noMetadata,picture.id,read(x)).clips.length,2,'相同标题和轨道本身不足以删掉声音');
  const shortAudio=media(x,'audio/wav',1),shortNativeVideo=media(x,'video/mp4',6,shortAudio);
  const oldShort={...legacy,clips:[{...picture,artifact:shortNativeVideo},{...native,linkedVideoClipId:undefined,artifact:shortAudio,durationFrames:24},separate]};
  const repaired=updateCutClip(oldShort,picture.id,{artifact:video},read(x),randomUUID);
  assert.equal(repaired.clips.find(c=>c.linkedVideoClipId===picture.id)!.durationFrames,48,'旧版自动缩短的原声也通过明确来源识别');
  assert.ok(repaired.clips.some(c=>c.id===separate.id));
  const copy=insertCutClip(inserted,{...picture,id:randomUUID(),atFrame:48},read(x),randomUUID);
  assert.equal(copy.clips.filter(c=>c.linkedVideoClipId).length,2);assert.equal(cutDuration(copy),96);
 }finally{x.close();}
});

test('07 复制画面保留原声音量、静音、所属轨道与裁切，并建立新的关联身份',()=>{
 const x=fixture();try{
  const audio=media(x,'audio/wav',6),video=media(x,'video/mp4',6,audio);adopted(x,video);
  const cut=x.run('cut.fromBoard',{title:'复制混音'}),picture=cut.data.clips[0],native=cut.data.clips.find((c:any)=>c.linkedVideoClipId===picture.id),track=randomUUID();
  let data=updateCutClip(cut.data,picture.id,{sourceInFrame:24,durationFrames:36},read(x),randomUUID);
  data={...data,tracks:[...data.tracks,{id:track,title:'现场对白',type:'dialogue',volume:.7,muted:false}]};
  data=updateCutClip(data,native.id,{trackId:track,volume:.2,muted:true},read(x),randomUUID);
  const original=structuredClone(data),copy=copyCutClip(data,picture.id,read(x),randomUUID),copiedPicture=copy.cut.clips.find(c=>c.id===copy.clipId)!,copiedSound=copy.cut.clips.find(c=>c.linkedVideoClipId===copy.clipId)!;
  assert.notEqual(copiedSound.id,native.id);assert.equal(copiedSound.artifact!.id,audio.id);assert.equal(copiedSound.trackId,track);assert.equal(copiedSound.volume,.2);assert.equal(copiedSound.muted,true);
  assert.equal(copiedPicture.atFrame,36);assert.equal(copiedSound.atFrame,36);assert.equal(copiedSound.durationFrames,36);assert.equal(copiedSound.sourceInFrame,24);assert.equal(copiedSound.sourceFps,copiedPicture.sourceFps);
  assert.deepEqual(data,original);assert.deepEqual(copy.cut.clips.slice(0,original.clips.length),original.clips);assert.deepEqual(copy.cut.tracks,original.tracks);
  assert.equal(copy.cut.clips.length,original.clips.length+2);assert.equal(cutDuration(copy.cut),72);
  assert.doesNotThrow(()=>x.run('cut.update',{id:cut.id,expectedSeq:cut.seq,data:copy.cut}));
 }finally{x.close();}
});

test('07 拒绝孤立、错源、不同步的原声关联以及替换后原声缺口',()=>{
 const x=fixture();try{
  const audio=media(x,'audio/wav',6),video=media(x,'video/mp4',6,audio),shortAudio=media(x,'audio/wav',1),otherVideo=media(x,'video/mp4',6,shortAudio);
  adopted(x,video);const cut=x.run('cut.fromBoard',{title:'校验'}),picture=cut.data.clips[0],native=cut.data.clips.find((c:any)=>c.linkedVideoClipId===picture.id);
  const save=(clips:any[])=>x.run('cut.update',{id:cut.id,expectedSeq:cut.seq,data:{...cut.data,clips}});
  assert.throws(()=>save(cut.data.clips.map((c:any)=>c.id===native.id?{...c,linkedVideoClipId:randomUUID()}:c)),/关联画面不存在/);
  assert.throws(()=>save(cut.data.clips.map((c:any)=>c.id===native.id?{...c,artifact:shortAudio,durationFrames:24}:c)),/原声与画面素材不匹配/);
  assert.throws(()=>save(cut.data.clips.map((c:any)=>c.id===native.id?{...c,sourceInFrame:24}:c)),/须跟随画面/);
  assert.throws(()=>updateCutClip(cut.data,picture.id,{artifact:otherVideo},read(x),randomUUID),/原声.*缺 1.00 秒/);
  assert.equal(x.app.editorial.repo.get(cut.id,x.pid).seq,cut.seq);
 }finally{x.close();}
});

test('07 两章 120 秒预算遇到短视频明确报缺口，补足后 Cut 和 Build 仍为 120 秒',()=>{
 const x=fixture();try{
  const chapters=[1,2].map(number=>x.run('chapter.create',{title:`第 ${number} 章`,number}));
  const shots=chapters.map((chapter,i)=>{const scene=x.run('scene.create',{title:`场景 ${i}`,chapterId:chapter.id}),ref=x.run('scene.checkpoint',{id:scene.id,expectedSeq:scene.seq});return x.run('shot.create',{title:`镜头 ${i}`,scene:ref,durationFrames:1440});});
  const plan=x.run('episode.fromChapters',{title:'两章两分钟',chapterIds:chapters.map(c=>c.id),targetSeconds:120});
  const attach=(artifact:Ref)=>{const s=x.app.storyboard.repo.get(shots[0].id,x.pid),input=x.run('shot.checkpoint',{id:s.id,expectedSeq:s.seq}),take=x.run('shot.take',{id:s.id,input,artifact}),row=x.app.storyboard.repo.get(s.id,x.pid);x.run('shot.adopt',{id:s.id,expectedSeq:row.seq,takeId:take.id});};
  attach(media(x,'video/mp4',5));
  assert.throws(()=>x.run('cut.fromBoard',{title:'不应缩短',episode:{id:plan.id,expectedSeq:plan.seq}}),/需 60.00 秒.*缺 55.00 秒/);
  assert.equal(x.app.editorial.repo.list(x.pid).length,0);assert.deepEqual(x.app.episodes.repo.get(plan.id,x.pid).data,plan.data);
  attach(media(x,'video/mp4',60,media(x,'audio/wav',60)));
  const cut=x.run('cut.fromBoard',{title:'完整预算',episode:{id:plan.id,expectedSeq:plan.seq}}),build=x.run('build.create',{id:cut.id,expectedSeq:cut.seq,title:'两分钟'});
  assert.equal(cutDuration(cut.data),2880);assert.deepEqual(build.data.range,{startFrame:0,endFrame:2880});assert.equal(build.data.snapshot.chapters.length,2);
 }finally{x.close();}
});

test('07 替换视频后真实 FFmpeg 成片使用新原声并保留裁切时长',async()=>{
 const x=fixture();try{
  const sounds:Ref[]=[],videos:Ref[]=[];
  for(const [i,frequency] of [440,880].entries()){
   const wav=join(x.root,`native-${i}.wav`),mp4=join(x.root,`video-${i}.mp4`);
   await execute(mediaBinary('ffmpeg'),['-v','error','-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000:duration=4`,wav]);
   await execute(mediaBinary('ffmpeg'),['-v','error','-f','lavfi','-i',`color=c=${i?'blue':'red'}:s=64x64:r=${i?24:16}:d=4`,'-an','-c:v','libx264','-pix_fmt','yuv420p',mp4]);
   sounds.push(await x.app.production.import(x.pid,wav,`原声 ${i}`));const data=await x.app.production.files.import(mp4,`视频 ${i}`,'fixture');videos.push(x.app.production.registerArtifact(x.pid,{...data,metadata:{nativeAudio:sounds[i]}}));
  }
  adopted(x,videos[0]);let cut=x.run('cut.fromBoard',{title:'真实替换'}),picture=cut.data.clips[0];
  let data=updateCutClip(cut.data,picture.id,{sourceInFrame:16,durationFrames:36},read(x),randomUUID);
  data=updateCutClip(data,picture.id,{artifact:videos[1],sourceFps:24,shot:undefined,takeId:undefined},read(x),randomUUID);
  cut=x.run('cut.update',{id:cut.id,expectedSeq:cut.seq,data:{...data,width:64,height:64}});
  const build=x.run('build.create',{id:cut.id,expectedSeq:cut.seq,title:'新声成片'}),rendering=x.run('build.render',{id:build.id,expectedSeq:build.seq});
  const job=await until(()=>x.app.production.jobs.get(rendering.data.jobId,x.pid),j=>['completed','failed','unknown'].includes(j.data.state),30000);assert.equal(job.data.state,'completed',job.data.error);
  const artifact=x.app.production.artifacts.at(job.data.artifact!,x.pid),pcm=join(x.root,'decoded.pcm');assert.ok(Math.abs(artifact.data.durationSeconds!-1.5)<.05);
  await execute(mediaBinary('ffmpeg'),['-v','error','-i',x.app.production.files.path(artifact.data.sha256),'-ss','0.25','-t','1','-vn','-ac','1','-ar','48000','-f','s16le',pcm]);
  const bytes=readFileSync(pcm);let crossings=0;for(let i=2;i<bytes.length;i+=2)if(bytes.readInt16LE(i-2)<=0&&bytes.readInt16LE(i)>0)crossings++;
  assert.ok(Math.abs(crossings-880)<5,`实际成片原声应为 880Hz，而不是旧声 440Hz，测得 ${crossings}`);
 }finally{x.close();}
});
