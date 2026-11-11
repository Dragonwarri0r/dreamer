import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../apps/host/application.ts';
import { createHost } from '../apps/host/server.ts';
import { seedInteractiveStory } from '../scripts/interactive-fixture.ts';

test('01 离线 Demo 阻断模型工厂和视频 Key 接口，复用样例可启动模拟',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-demo-test-'));let factoryCalls=0;
 const app=new Application(root,{offline:true,agentFactory:()=>{factoryCalls++;throw new Error('external factory reached');}}),server=createHost(app);
 try{
  assert.equal(app.cloudVideo.length,0);
  assert.deepEqual([...app.production.providers.keys()],['ffmpeg']);
  const projectId=randomUUID();app.bus.execute({projectId,requestId:randomUUID(),operation:'project.create',payload:{title:'Demo'}},{source:'human'});
  const f=await seedInteractiveStory(app,projectId,false);
  const result=f.command('simulation.start',{id:f.script.id,expectedSeq:f.script.seq,uid:'demo-reader'});
  assert.equal(result.view.run.mode,'simulation');
  assert.equal(app.production.jobs.list(projectId).length,0);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const response=await fetch(url+'/api/session'),cookie=response.headers.get('set-cookie')!.split(';')[0],session=await response.json() as any;
  assert.equal(session.offline,true);
  const headers={cookie,origin:url,'x-dreamer-csrf':session.csrf,'content-type':'application/json'};
  for(const path of ['/api/video-settings','/api/video-settings/check']){
   const response=await fetch(url+path,{method:'POST',headers,body:JSON.stringify({id:'seedance',enabled:true,model:'doubao-seedance-2-5-260628',apiKey:'demo-only'})});
   assert.equal(response.status,403);
  }
  // Even direct Agent entry cannot reach the real/injected model factory.
  const thread=f.command('thread.create',{title:'Demo guard',goal:'Do not run a model'});
  const owner=randomUUID();f.command('thread.claim',{id:thread.id,owner,expectedSeq:thread.seq});
  f.command('thread.send',{id:thread.id,owner,text:'Test offline guard'});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(factoryCalls,0);
  assert.equal(existsSync(join(root,'runtime','codex','auth.json')),false);
  assert.equal(existsSync(join(root,'credentials','video-providers.json')),false);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));app.close();rmSync(root,{recursive:true,force:true});}
});
