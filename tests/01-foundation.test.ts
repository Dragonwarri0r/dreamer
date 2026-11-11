import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SqliteStore,supportsSafeWal } from '../packages/infra/sqlite.ts';
import { CommandBus, Projects } from '../packages/core/foundation/commands.ts';
import { ProjectData } from '../packages/contracts/foundation.ts';

function setup() {
 const root=mkdtempSync(join(tmpdir(),'dreamer-foundation-'));const store=new SqliteStore(root),bus=new CommandBus(store),projects=new Projects(store,bus),id=randomUUID();
 const command={requestId:randomUUID(),projectId:id,operation:'project.create',payload:{title:'电影'}};
 return {root,store,bus,projects,id,command,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test('01 SQLite 引擎版本控制 WAL，未修复版本使用事务回滚日志',()=>{assert.equal(supportsSafeWal('3.51.2'),false);assert.equal(supportsSafeWal('3.51.3'),true);assert.equal(supportsSafeWal('3.50.7'),true);assert.equal(supportsSafeWal('3.44.5'),false);const x=setup();try{const health=x.store.health();assert.equal(health.journalMode,supportsSafeWal(health.sqlite)?'wal':'delete');}finally{x.close();}});
test('01 创建、重复请求与重启保留同一业务结果',()=>{const x=setup();try{
 const a=x.bus.execute(x.command,{source:'human'}),b=x.bus.execute(x.command,{source:'human'});assert.equal(b.replayed,true);assert.deepEqual(a.result,b.result);assert.equal(x.store.events(x.id,0).length,1);
 assert.throws(()=>x.bus.execute({...x.command,payload:{title:'另一份'}},{source:'human'}),/请求标识/);
 x.store.close();const reopened=new SqliteStore(x.root);assert.equal(reopened.repository('project',ProjectData).get(x.id,x.id).data.title,'电影');reopened.close();
 }finally{rmSync(x.root,{recursive:true,force:true});}});
test('01 未发布草稿冲突和固定检查点',()=>{const x=setup();try{
 x.bus.execute(x.command,{source:'human'});const ref=x.projects.repo.checkpoint(x.id,x.id,1);
 x.projects.repo.save(x.id,x.id,1,{...x.projects.repo.get(x.id,x.id).data,title:'新版'});
 assert.throws(()=>x.projects.repo.save(x.id,x.id,1,{...x.projects.repo.get(x.id,x.id).data,title:'旧版'}),/草稿已更新/);
 assert.equal(x.projects.repo.at(ref,x.id).data.title,'电影');assert.throws(()=>x.projects.repo.at(ref,randomUUID()),/固定修订/);
 }finally{x.close();}});
test('01 业务数据与收据原子回滚，禁止事务等待外部调用',()=>{const x=setup();try{
 x.bus.register('bad',z.object({}),()=>{x.projects.repo.create(x.id,ProjectData.parse({title:'回滚'}),x.id);throw new Error('故障注入');});
 assert.throws(()=>x.bus.execute({...x.command,operation:'bad',payload:{}},{source:'human'}),/故障注入/);assert.equal(x.projects.repo.list(x.id).length,0);assert.equal(x.store.events(x.id,0).length,0);
 assert.throws(()=>x.store.transaction(()=>Promise.resolve()),/异步调用/);
 }finally{x.close();}});
test('01 Agent 权限和项目范围不能通过请求字段提升',()=>{const x=setup();try{
 assert.throws(()=>x.bus.execute(x.command,{source:'agent',allowed:[]}),/范围/);
 assert.throws(()=>x.bus.execute({...x.command,actor:'human'},{source:'agent',allowed:['project.create']}),/约定/);
 assert.throws(()=>x.bus.execute(x.command,{source:'human',projectId:randomUUID()}),/范围/);
 }finally{x.close();}});
test('01 数据库一致性备份可恢复且拒绝覆盖原目录',async()=>{const x=setup();const destination=x.root+'-backup';try{
 x.bus.execute(x.command,{source:'human'});await assert.rejects(x.store.backup(x.root),/新目录/);await x.store.backup(destination);
 const restored=new SqliteStore(destination);assert.equal(restored.repository('project',ProjectData).get(x.id,x.id).data.title,'电影');restored.close();
 }finally{x.close();rmSync(destination,{recursive:true,force:true});}});
