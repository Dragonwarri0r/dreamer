import {chromium} from 'playwright';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {fixture} from '../tests/helpers.ts';
import {createHost} from '../apps/host/server.ts';

const output=resolve(`test-results/novel-export-${Date.now()}`);mkdirSync(output,{recursive:true});
const x=fixture({recover:false,providers:[]}),chapters=[];
for(let n=41;n>=1;n--)chapters.push(x.run('chapter.create',{title:`离线审阅章节${n}`,number:n,body:`第${n}章正文。\n`+'种田收获。'.repeat(800),volume:n<21?'第一卷':'第二卷'}));
x.run('chapter.create',{title:'只有提纲',number:42});
const server=createHost(x.app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${(server.address() as any).port}`;
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks:string[]=[],errors:string[]=[];
page.on('pageerror',e=>errors.push(e.message));
async function exportClick(){const response=page.waitForResponse(r=>r.url().endsWith('/api/novel-export')&&r.request().method()==='POST');await page.getByRole('button',{name:'导出小说',exact:true}).click();const result=await (await response).json();assert.ok(!result.error);await page.waitForFunction(path=>(document.querySelector('[aria-label="小说导出目录"]') as HTMLInputElement)?.value===path,result.directory);return result;}
try{
  await page.goto(`${url}/?project=${x.pid}&window=export-test`);
  await page.locator('aside nav').getByRole('button',{name:'内容与制作'}).click();await page.locator('aside nav').getByRole('button',{name:'章节书架',exact:true}).click();
  await page.locator('.chapter-row').first().waitFor();assert.equal(await page.locator('.chapter-row').count(),30);
  await page.getByLabel('搜索章节').fill('#41');await page.waitForFunction(()=>document.querySelectorAll('.chapter-row').length===1);
  const before=x.app.snapshot(x.pid),whole=await exportClick();assert.equal(whole.chapterCount,41);assert.equal(whole.skippedEmptyCount,1);assert.equal(whole.files.length,1);assert.deepEqual(x.app.snapshot(x.pid),before);checks.push('Filtered/paginated library exports all 41 saved chapters, skipping one empty chapter, without source changes');
  const downloadWait=page.waitForEvent('download');await page.getByRole('link',{name:whole.files[0].name,exact:true}).click();const download=await downloadWait,downloadPath=join(output,'download.txt');await download.saveAs(downloadPath);assert.equal(readFileSync(downloadPath,'utf8'),readFileSync(join(whole.directory,whole.files[0].name),'utf8'));checks.push('Download matches saved UTF-8 file');
  await page.getByLabel('小说分文件方式').selectOption('100k');const split=await exportClick();assert.equal(split.files.length,2);assert.ok(split.files.every((f:any)=>f.characters<=100000));assert.equal(split.files.reduce((n:number,f:any)=>n+f.chapterCount,0),41);checks.push('100,000-character split keeps chapters complete');
  await page.getByLabel('小说分文件方式').selectOption('custom');await page.getByLabel('每个文件万字数').fill('0');assert.equal(await page.getByRole('button',{name:'导出小说',exact:true}).isDisabled(),true);await page.getByLabel('每个文件万字数').fill('1');const custom=await exportClick();assert.equal(custom.files.length,21);checks.push('Custom split validates input and produces 21 complete-chapter files');
  await page.route('**/api/novel-export',async route=>{await route.fetch();await route.abort('failed');});
  const previousCount=readdirSync(join(custom.directory,'..')).length;
  await page.getByRole('button',{name:'导出小说',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(readdirSync(join(custom.directory,'..')).length,previousCount+1);
  await page.unroute('**/api/novel-export');await page.reload();await page.getByRole('button',{name:'重试导出',exact:true}).waitFor();await page.getByRole('button',{name:'重试导出',exact:true}).click();await page.getByRole('button',{name:'导出小说',exact:true}).waitFor();assert.equal(readdirSync(join(custom.directory,'..')).length,previousCount+1);checks.push('Lost response survives reload and retry recovers the same export');
  await page.screenshot({path:join(output,'desktop.png')});
  for(const width of [390,320]){await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'导出小说',exact:true}).scrollIntoViewIfNeeded();assert.equal(await page.locator('.novel-export').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);const box=await page.getByRole('button',{name:'导出小说',exact:true}).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1);await page.screenshot({path:join(output,`mobile-${width}.png`)});}checks.push('Export controls and directory fit 390px and 320px windows');
  await page.setViewportSize({width:1440,height:1000});await page.getByLabel('搜索章节').fill('#1');await page.locator('.chapter-row').filter({hasText:'离线审阅章节1'}).getByRole('button',{name:/离线审阅章节1/}).first().click();await page.getByLabel('章节正文',{exact:true}).waitFor();const body=await page.getByLabel('章节正文').inputValue();await page.getByLabel('章节正文').fill(body+'未保存的修改');await page.getByRole('button',{name:'章节目录',exact:true}).click();await page.getByText('有未保存的章节修改，本次仅导出已保存版本。',{exact:false}).waitFor();await page.getByRole('button',{name:'查看未保存章节',exact:true}).click();assert.ok((await page.getByLabel('章节正文').inputValue()).endsWith('未保存的修改'));checks.push('Unsaved chapter warning navigates back to the editable draft');
  assert.deepEqual(errors,[]);assert.equal(x.app.production.jobs.list(x.pid).length,0);
  writeFileSync(join(output,'report.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,output,checks}));
}catch(e){await page.screenshot({path:join(output,'failure.png'),fullPage:true});console.error(JSON.stringify({output,checks,errors,body:(await page.locator('body').innerText()).slice(-3500)}));throw e;}
finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await browser.close();x.close();}
