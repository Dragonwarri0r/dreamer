import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../apps/host/application.ts';
import { createHost } from '../apps/host/server.ts';
test('01 HTTP 本地会话、Origin、CSRF、重复命令与项目查询',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dreamer-http-')),app=new Application(root),server=createHost(app);
 try{
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
 assert.equal((await fetch(url+'/api/projects')).status,403);
 const session=await fetch(url+'/api/session'),cookie=session.headers.get('set-cookie')!.split(';')[0],{csrf}=await session.json() as any;
 const command={requestId:randomUUID(),projectId:randomUUID(),operation:'project.create',payload:{title:'本机电影'}};
 const headers={'content-type':'application/json',cookie,origin:url,'x-dreamer-csrf':csrf};
 assert.equal((await fetch(url+'/api/commands',{method:'POST',headers:{...headers,origin:'https://evil.example'},body:JSON.stringify(command)})).status,403);
 assert.equal((await fetch(url+'/api/commands',{method:'POST',headers,body:JSON.stringify(command)})).status,200);
 const replay=await (await fetch(url+'/api/commands',{method:'POST',headers,body:JSON.stringify(command)})).json() as any;assert.equal(replay.replayed,true);
 const projects=await(await fetch(url+'/api/projects',{headers:{cookie}})).json() as any[];assert.equal(projects[0].data.title,'本机电影');
 }finally{await new Promise<void>(r=>server.close(()=>r()));app.close();rmSync(root,{recursive:true,force:true});}
});
