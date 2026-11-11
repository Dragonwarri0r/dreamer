import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

test('01 公开副本拒绝敏感文件、符号链接、工作树与暂存密钥，安全导出不包含私有目录',()=>{
 const parent=mkdtempSync(join(tmpdir(),'dreamer-public-test-')),root=join(parent,'source');
 mkdirSync(join(root,'scripts'),{recursive:true});mkdirSync(join(root,'config'));
 copyFileSync(resolve('scripts/public-source.mjs'),join(root,'scripts/public-source.mjs'));
 const manifest=(include:string[])=>writeFileSync(join(root,'config/public-source.json'),JSON.stringify({include}));
 const run=(...args:string[])=>spawnSync(process.execPath,['scripts/public-source.mjs',...args],{cwd:root,encoding:'utf8'});
 try{
  writeFileSync(join(root,'README.md'),'public source');writeFileSync(join(root,'.env.local'),'private config');
  manifest(['README.md']);const exported=join(parent,'review');assert.equal(run('--output',exported).status,0);assert.equal(readFileSync(join(exported,'README.md'),'utf8'),'public source');assert.equal(existsSync(join(exported,'.env.local')),false);
  assert.notEqual(run('--output',exported).status,0);assert.notEqual(run('--output',join(root,'nested')).status,0);
  manifest(['.env.local']);assert.notEqual(run().status,0);
  symlinkSync(join(root,'.env.local'),join(root,'linked.txt'));manifest(['linked.txt']);assert.notEqual(run().status,0);
  const sentinel='sk-'+ 'X'.repeat(40);writeFileSync(join(root,'README.md'),sentinel);manifest(['README.md']);const leaked=run();assert.notEqual(leaked.status,0);assert.equal(leaked.stdout.includes(sentinel),false);
  execFileSync('git',['init','--quiet'],{cwd:root});execFileSync('git',['add','README.md'],{cwd:root});writeFileSync(join(root,'README.md'),'clean working file');
  const staged=run();assert.notEqual(staged.status,0);assert.match(staged.stdout,/index/);assert.equal(staged.stdout.includes(sentinel),false);
 }finally{rmSync(parent,{recursive:true,force:true});}
});
