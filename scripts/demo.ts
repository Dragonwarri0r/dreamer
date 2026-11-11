import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../apps/host/application.ts';
import { createHost } from '../apps/host/server.ts';
import { seedInteractiveStory } from './interactive-fixture.ts';

// Always start fresh. Never inherit DREAMER_DATA_ROOT, credentials or model setup.
const withMedia=process.argv.includes('--media');
if(process.argv.slice(2).some(arg=>arg!=='--media'))throw new Error('用法：npm run demo [-- --media]');
const port=Number(process.env.DREAMER_DEMO_PORT??4326);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('DREAMER_DEMO_PORT 无效');
if(!existsSync('dist/studio/index.html'))throw new Error('请先运行 npm run build');
const root=mkdtempSync(join(tmpdir(),'dreamer-demo-'));
const app=new Application(root,{offline:true}),server=createHost(app);
let stopping=false;
function cleanup(){app.close();rmSync(root,{recursive:true,force:true});}
function stop(){if(stopping)return;stopping=true;server.close(()=>{cleanup();process.exit(process.exitCode??0);});server.closeAllConnections();}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,stop);
try{
 const projectId=randomUUID();
 app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'Dreamer Demo · 城门选择',brief:'内置确定性测试样例。无真实模型生成；退出后清空。',width:320,height:180,fps:24}},{source:'human'});
 const fixture=await seedInteractiveStory(app,projectId,withMedia,{audio:false});
 let query:URLSearchParams;
 if(withMedia){
  fixture.command('script.publish',{id:fixture.script.id,expectedSeq:fixture.script.seq,kind:'playback',confirmGeneration:false});
  query=new URLSearchParams({project:projectId,editor:'experience',title:'Demo 互动播放',binding:'uid:demo-reader'});
 }else{
  const result=fixture.command('simulation.start',{id:fixture.script.id,expectedSeq:fixture.script.seq,uid:'demo-reader'});
  query=new URLSearchParams({project:projectId,editor:'experience',title:'Demo 逻辑模拟',binding:'uid:demo-reader',object:result.view.run.id});
 }
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 console.log(`Dreamer 离线 Demo：http://127.0.0.1:${port}/?${query}`);
 console.log(withMedia?'画面为本地 FFmpeg 色块夹具，无 AI 生成。':'请选择一个选项，再点“模拟片段结束”，体验分支与结局。');
 console.log(`无需 Key、Codex 或模型；不保存视频 Key。临时数据：${root}；Ctrl+C 退出并清理。`);
}catch(error){process.exitCode=1;console.error((error as Error).message);stop();}
