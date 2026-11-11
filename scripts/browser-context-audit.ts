import {chromium} from 'playwright';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {Application} from '../apps/host/application.ts';
import {createHost} from '../apps/host/server.ts';
import {ThreadData} from '../packages/contracts/agent.ts';

const root=mkdtempSync(join(tmpdir(),'dreamer-context-audit-')),out=resolve('test-results/context-audit');
mkdirSync(out,{recursive:true});
const app=new Application(root,{agentFactory:()=>({
 async start(){return randomUUID();},
 async turn(_id,_text,event){setTimeout(()=>event({type:'complete'}),30);return randomUUID();},
 async interrupt(){},close(){},
})});
const pid=randomUUID(),run=(operation:string,payload:any)=>app.bus.execute({requestId:randomUUID(),projectId:pid,operation,payload},{source:'human'}).result as any;
run('project.create',{title:'同名对象上下文审计'});
const first=run('scene.create',{title:'同名场景',synopsis:'场景甲：街口领取纸条',order:0});
const second=run('scene.create',{title:'同名场景',synopsis:'场景乙：仓房领取蒸笼',order:1});
const parent=run('thread.create',{title:'主创作会话'});
const child=app.agents.threads.create(pid,ThreadData.parse({
 title:'只读子任务',workId:parent.data.workId,state:'idle',
 delegation:{parentThreadId:parent.id,parentTurnId:randomUUID(),callId:'fixture',inputHash:'a'.repeat(64)},
}));
const server=createHost(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(server.address() as any).port}`,windowId=randomUUID();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks:string[]=[],errors:string[]=[];
page.on('pageerror',error=>errors.push(error.message));
const story=async(synopsis:string)=>{
 const nav=page.locator('aside nav');
 if(!await nav.getByRole('button',{name:'故事与剧本',exact:true}).count())await nav.getByRole('button',{name:'内容与制作',exact:true}).click();
 await nav.getByRole('button',{name:'故事与剧本',exact:true}).click();
 await page.locator('.content-card').filter({hasText:synopsis}).click();
 await page.getByRole('button',{name:'发送给 Agent',exact:true}).waitFor();
};
try{
 await page.goto(`${base}/?${new URLSearchParams({project:pid,window:windowId,editor:'overview'})}`);
 await page.getByRole('button',{name:'继续创作',exact:true}).click();
 await page.waitForFunction(id=>(document.querySelector('[aria-label="创作会话"]') as HTMLSelectElement)?.value===id,parent.id);
 assert.equal(await page.getByLabel('给 Agent 的消息').count(),1);
 checks.push('project continue action selects a writable root conversation even when a child is newest');
 await story('场景甲');await page.getByRole('button',{name:'发送给 Agent',exact:true}).click();
 assert.equal(await page.getByLabel('目标 Agent 会话').locator(`option[value="${child.id}"]`).count(),0);
 await page.getByLabel('目标 Agent 会话').selectOption(parent.id);
 await page.getByLabel('选区修改要求').fill('只处理场景甲');
 let lose=true;
 await page.route('**/api/commands',async route=>{
  if(lose&&route.request().postDataJSON().operation==='thread.send'){
   lose=false;const response=await route.fetch();assert.equal(response.status(),200,await response.text());await route.abort('failed');
  }else await route.continue();
 });
 await page.getByRole('button',{name:'固定上下文并发送',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Failed to fetch'}).waitFor();
 assert.equal(app.agents.threads.get(parent.id,pid).data.turns.length,1);
 let expired=true;
 await page.route('**/api/receipt',async route=>{
  if(expired){expired=false;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'FORBIDDEN',message:'会话已失效，请刷新连接'}})});}
  else await route.continue();
 });
 await page.getByRole('button',{name:'核对上次发送',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'会话已失效'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'核对上次发送',exact:true}).count(),1);
 await page.reload();await page.getByRole('button',{name:'发送给 Agent',exact:true}).click();
 assert.equal(await page.getByLabel('选区修改要求').inputValue(),'只处理场景甲');
 assert.equal(await page.getByLabel('选区修改要求').isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'核对上次发送',exact:true}).count(),1);
 checks.push('an expired-session receipt response preserves the uncertain send and its request identity across reload');
 await page.getByRole('button',{name:'取消',exact:true}).click();
 await story('场景乙');await page.getByRole('button',{name:'发送给 Agent',exact:true}).click();
 assert.equal(await page.getByLabel('选区修改要求').isDisabled(),false);
 assert.equal(await page.getByLabel('选区修改要求').inputValue(),'');
 assert.equal(await page.getByRole('button',{name:'核对上次发送',exact:true}).count(),0);
 assert.equal(await page.getByLabel('目标 Agent 会话').locator(`option[value="${child.id}"]`).count(),0);
 await page.getByLabel('目标 Agent 会话').selectOption(parent.id);
 await page.getByLabel('选区修改要求').fill('只处理场景乙');
 await page.getByRole('button',{name:'固定上下文并发送',exact:true}).click();
 await page.getByRole('dialog',{name:'发送上下文给 Agent'}).waitFor({state:'detached'});
 const turns=app.agents.threads.get(parent.id,pid).data.turns;
 assert.equal(turns.length,2);
 assert.ok(turns[0].bindings.some(b=>b.ref.id===first.id));
 assert.equal(turns[0].bindings.some(b=>b.ref.id===second.id),false);
 assert.ok(turns[1].bindings.some(b=>b.ref.id===second.id));
 assert.equal(turns[1].bindings.some(b=>b.ref.id===first.id),false);
 checks.push('same-title scene dialogs isolate pending submissions and send only their own fixed object context');
 await story('场景甲');await page.getByRole('button',{name:'发送给 Agent',exact:true}).click();
 assert.equal(await page.getByLabel('选区修改要求').inputValue(),'只处理场景甲');
 await page.getByRole('button',{name:'核对上次发送',exact:true}).click();
 await page.getByRole('dialog',{name:'发送上下文给 Agent'}).waitFor({state:'detached'});
 assert.equal(app.agents.threads.get(parent.id,pid).data.turns.length,2);
 checks.push('returning to the original scene reconciles its accepted request without a duplicate turn; child threads are excluded');
 await page.goto(`${base}/?${new URLSearchParams({project:pid,window:randomUUID(),editor:'agent'})}`);
 await page.waitForFunction(id=>(document.querySelector('[aria-label="创作会话"]') as HTMLSelectElement)?.value===id,parent.id);
 assert.equal(await page.getByLabel('给 Agent 的消息').count(),1);
 checks.push('new Agent editor defaults to the latest writable root rather than the latest child');
 await page.screenshot({path:join(out,'context-isolation.png')});
 assert.deepEqual(errors,[]);
 writeFileSync(join(out,'report.json'),JSON.stringify({passed:true,checks,errors,fixture:'temporary project and deterministic Agent session; no real project changes'},null,2));
 console.log(JSON.stringify({passed:true,checks}));
}catch(error){await page.screenshot({path:join(out,'failure.png'),fullPage:true});console.error(JSON.stringify({checks,errors,body:(await page.locator('body').innerText()).slice(-4000)}));throw error;}
finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));app.close();rmSync(root,{recursive:true,force:true});}
