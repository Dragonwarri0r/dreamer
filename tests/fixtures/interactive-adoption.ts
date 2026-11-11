import { randomUUID } from 'node:crypto';
import type { Application } from '../../apps/host/application.ts';
import { ScriptPlanData, type FixedMedia } from '../../packages/contracts/interactive-script.ts';
import { SegmentScriptV1, type SegmentInstance } from '../../packages/contracts/experience.ts';
import { contentHash } from '../../packages/core/story/script.ts';

/** Synthetic private text, no model or media generation. Also used by the isolated browser fixture. */
export function seedAdoption(app:Application,pid:string,options:{media?:FixedMedia}={}){
 const command=(operation:string,payload:unknown)=>app.bus.execute({projectId:pid,requestId:randomUUID(),operation,payload},{source:'human'}).result as any;
 const chapter=command('chapter.create',{title:'提取目标章节',number:1,body:'作者原有正文。'}),chapterRef=command('chapter.checkpoint',{id:chapter.id,expectedSeq:chapter.seq});
 const scene=command('scene.create',{title:'提取目标场景',chapterId:chapter.id,blocks:[{id:randomUUID(),type:'action',text:'作者原有场景。'}]}),sceneRef=command('scene.checkpoint',{id:scene.id,expectedSeq:scene.seq});
 const node=randomUUID(),ending=randomUUID();
 const plan=ScriptPlanData.parse({schemaVersion:1,title:'个人正文提取测试',chapterRefs:[chapterRef],entryNodeId:node,nodes:[{id:node,type:'segment',mode:'fixed',title:'个人段落',chapterId:chapter.id,outlineOrder:0,sourceSceneRefs:[sceneRef],contentSpec:{mode:'fixed',...(options.media?{media:options.media}:{})},next:ending},{id:ending,type:'ending',title:'结束',outlineOrder:1,endingKey:'end',summary:'结束。'}]});
 const mode=options.media?'playback':'simulation',script=command('script.create',plan),release=command('script.publish',{id:script.id,expectedSeq:script.seq,kind:mode}).release;
 const uid='private-adoption-reader',started=app.experienceRuntime.start({projectId:pid,uid},{protocolVersion:1,projectId:pid,requestId:randomUUID(),releaseId:release.id,mode}).view;
 const scope={projectId:pid,uid,runId:started.run.id},row=app.store.experience.get<SegmentInstance>('instances',started.instance!.id,scope);
 const scenes=[{id:randomUUID(),title:'城门旁',location:'城门',time:'黄昏',blocks:[{id:randomUUID(),type:'dialogue',speaker:'旅人',text:'只属于这个实例的提取正文。'}]},{id:randomUUID(),title:'桥上',location:'桥',time:'夜',blocks:[{id:randomUUID(),type:'action',text:'另一段已审的个人正文。'}]}];
 const generated=SegmentScriptV1.parse({schemaVersion:1,instanceId:row.id,inputHash:row.data.inputHash,outcomeId:'continue',timelineFps:24,scenes,sourceRefs:[sceneRef],usedVariables:[],assertedFacts:[],shotPlan:[{id:randomUUID(),sceneId:scenes[0].id,goal:'过门',action:'走过城门',sound:'脚步',durationFrames:24,resourceRefs:[]}],contentChecks:[]});
 app.store.transaction(()=>{
  app.store.experience.create('results',scope,{instanceId:row.id,resultRevision:1,contentHash:contentHash(generated),script:generated});
  app.store.experience.save('instances',row.id,scope,row.seq,{...row.data,status:'ready',resultRevision:1,scriptResult:generated,variableSnapshot:{privateValue:'不会公开的个人输入'},checks:[{id:randomUUID(),stage:'structure',status:'passed',resultRevision:1,message:'fixture'},{id:randomUUID(),stage:'authorReview',status:'passed',resultRevision:1,message:'fixture'}]});
 });
 return {chapter,chapterRef,scene,sceneRef,script,release,scope,instanceId:row.id,generated,proposal:{uid,runId:scope.runId,instanceId:row.id,resultRevision:1,target:chapterRef,mode:'append' as const,confirmDisclosure:true as const}};
}
