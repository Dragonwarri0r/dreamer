import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Application} from '../apps/host/application.ts';
import {cityGateFixture} from '../tests/fixtures/interactive-script.ts';
import {execute,mediaBinary} from '../packages/infra/media.ts';

/** Finite author fixture; generated color/audio are local FFmpeg test media, never AI output. */
export async function seedInteractiveStory(app:Application,pid:string,withMedia=false,options:{audio?:boolean}={}){
 const command=(operation:string,payload:unknown)=>app.bus.execute({projectId:pid,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
 const f=cityGateFixture(),chapter=command('chapter.create',{title:'城门前',number:1,body:'暮色中，你来到城门。守卫受伤，证物等待核验。'}),chapterRef=command('chapter.checkpoint',{id:chapter.id,expectedSeq:chapter.seq});
 const scene=command('scene.create',{title:'暮色下的城门',chapterId:chapter.id,blocks:[{id:f.ids.block,type:'action',text:'守卫抬起头，等待你的回应。'}]}),sceneRef=command('scene.checkpoint',{id:scene.id,expectedSeq:scene.seq});
 let media:any;
 if(withMedia){
  const path=join(app.root,'interactive-fixture.mp4');await execute(mediaBinary('ffmpeg'),['-y','-v','error','-f','lavfi','-i','color=c=0x416b65:s=320x180:r=24',...(options.audio===false?[]:['-f','lavfi','-i','sine=frequency=330:sample_rate=24000']),'-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path]);
  const artifact=await app.production.import(pid,path,'城门固定测试视频'),track=randomUUID();
  const cut=command('cut.create',{title:'城门固定素材',width:320,height:180,fps:24,tracks:[{id:track,title:'画面',type:'video'}],clips:[{id:randomUUID(),trackId:track,title:'城门',atFrame:0,durationFrames:72,sourceInFrame:0,sourceFps:24,artifact}]});
  const build=command('build.create',{id:cut.id,expectedSeq:cut.seq,title:'城门固定成片'}),ready=app.editorial.builds.save(build.id,pid,build.seq,{...build.data,state:'completed',output:artifact});app.editorial.builds.checkpoint(ready.id,pid,ready.seq);
  media=app.scriptMedia(pid).find((m:any)=>m.media.buildRef.id===ready.id);
 }
 f.plan.chapterRefs=[chapterRef];f.plan.nodes=f.plan.nodes.map(node=>({...node,...('chapterId' in node?{chapterId:chapter.id}:{}),...(node.type==='segment'?{sourceSceneRefs:[sceneRef],contentSpec:{mode:'fixed',...(media?{media:media.media}:{})}}:{})})) as typeof f.plan.nodes;
 f.plan.cues=f.plan.cues.map(c=>({...c,anchor:{...c.anchor,ref:sceneRef},deadlineFrame:36,...(media?{resolvedBinding:{planId:media.planId,contentHash:media.media.contentHash,fps:24,appearFrame:12}}:{})}));
 const script=command('script.create',f.plan);return {script,ids:f.ids,plan:f.plan,media,command};
}
