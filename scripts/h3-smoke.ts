// Explicit real model run, isolated from existing projects; no implicit retries.
import {Application} from '../apps/host/application.ts';
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import profiles from '../packages/contracts/h3-profiles.json' with {type:'json'};
const profile=process.argv[2]??'h3-quality/v1';
if(!(profile in profiles))throw new Error('选择 h3-quality/v1 或 h3-turbo/v1');
const p=profiles[profile as keyof typeof profiles],runId=randomUUID();
const root=resolve('.local/acceptance',`h3-${runId}`),out=resolve('test-results/h3',runId);
mkdirSync(out,{recursive:true});const app=new Application(root),pid=randomUUID();
const run=(operation:string,payload:any)=>app.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
try {
 run('project.create',{title:'H3 本地高质量链验收',generationLimit:1});
 const reference=process.argv[3]?await app.production.import(pid,resolve(process.argv[3]),'H3 首帧参考'):undefined;
 const shot=run('shot.create',{title:process.env.DREAMER_H3_TEST_TITLE??'H3 本地动态镜头',durationFrames:124});
 const target=run('shot.checkpoint',{id:shot.id,expectedSeq:shot.seq});
 const job=run('job.submit',{provider:'h3',profile,quality:p.final?'final':'draft',target,references:reference?[reference]:[],
  prompt:process.env.DREAMER_H3_TEST_PROMPT??'A cinematic medium shot of a young woman in a yellow raincoat, standing on an empty tram platform at dusk. She slowly turns her head toward the camera and smiles gently. One continuous shot, locked camera, one person, consistent face and clothing, soft warm platform light, natural motion. Quiet evening station ambience, no dialogue, no music, no subtitles or text.',
  constraints:{width:p.width,height:p.height,fps:p.fps,durationSeconds:p.frames/p.fps,audio:true},seed:42});
 console.log(JSON.stringify({root,projectId:pid,jobId:job.id,out,profile}));
 let row=job,last='';
 const deadline=Date.now()+185*60*1000;
 while(Date.now()<deadline){
  row=app.production.jobs.get(job.id,pid);
  if(row.data.state!==last){console.log(JSON.stringify({state:row.data.state,error:row.data.error}));last=row.data.state;}
  if(['completed','failed','cancelled','unknown'].includes(row.data.state))break;
  await new Promise(r=>setTimeout(r,2000));
 }
 const report={root,projectId:pid,job:row,contentQualityAccepted:false};
 writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));
 if(row.data.artifact){
  const artifact=app.production.artifacts.at(row.data.artifact,pid);
  copyFileSync(app.production.files.path(artifact.data.sha256),join(out,'output.mp4'));
  if(app.storyboard.repo.get(shot.id,pid).data.takes.length!==1)throw new Error('生成结果没有准确挂接到镜头候选');
 }
 console.log(JSON.stringify({state:row.data.state,error:row.data.error,metrics:row.data.metrics,report:join(out,'report.json')}));
 if(row.data.state!=='completed')process.exitCode=1;
}finally{app.close();}
