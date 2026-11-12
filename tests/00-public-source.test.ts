import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';

const repo=resolve(import.meta.dirname,'..');
// Construct an invalid synthetic marker; never use personal credentials in these tests.
const marker='sk-'+'A'.repeat(40);
function fixture(run:(root:string)=>void){
 const root=mkdtempSync(join(tmpdir(),'dreamer-source-guard-'));
 try{
  for(const dir of ['scripts','config','apps'])mkdirSync(join(root,dir));
  copyFileSync(join(repo,'scripts/public-source.mjs'),join(root,'scripts/public-source.mjs'));
  copyFileSync(join(repo,'.gitignore'),join(root,'.gitignore'));
  writeFileSync(join(root,'README.md'),'Public source fixture\n');
  writeFileSync(join(root,'.env.example'),'DREAMER_PORT=4327\n');
  writeFileSync(join(root,'config/public-source.json'),JSON.stringify({version:1,include:['.gitignore','.env.example','README.md','scripts/public-source.mjs','config/public-source.json','apps']}));
  execFileSync('git',['init','-q'],{cwd:root});
  run(root);
 }finally{rmSync(root,{recursive:true,force:true});}
}
function check(root:string){
 const result=spawnSync(process.execPath,['scripts/public-source.mjs'],{cwd:root,encoding:'utf8'});
 assert.ifError(result.error);
 assert.ok(!result.stdout.includes(marker)&&!result.stderr.includes(marker),'diagnostics must not expose matching values');
 return {status:result.status,report:JSON.parse(result.stdout) as {files:number;findings:{path:string;rule:string}[]}};
}

test('00 public source ignores local credentials and Finder metadata while preserving the reviewed template',()=>fixture(root=>{
 writeFileSync(join(root,'.env.local'),marker);
 writeFileSync(join(root,'apps/.DS_Store'),Buffer.from([0,1,2,3]));
 const result=check(root);assert.equal(result.status,0);assert.deepEqual(result.report.findings,[]);
 const files=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n');
 assert.ok(files.includes('.env.example'));assert.ok(!files.includes('.env.local'));assert.ok(!files.includes('apps/.DS_Store'));
}));

test('00 untracked files outside the manifest are scanned and block publication',()=>fixture(root=>{
 writeFileSync(join(root,'config/accidental-note.txt'),marker);
 const result=check(root);assert.equal(result.status,1);
 assert.ok(result.report.findings.some(f=>f.path==='config/accidental-note.txt'&&f.rule==='untracked file outside public manifest'));
 assert.ok(result.report.findings.some(f=>f.path==='config/accidental-note.txt'&&f.rule==='provider token'));
}));

test('00 staged secret is rejected even after the working copy has been cleaned',()=>fixture(root=>{
 writeFileSync(join(root,'README.md'),marker);
 execFileSync('git',['add','--','README.md'],{cwd:root});
 writeFileSync(join(root,'README.md'),'Clean working copy\n');
 const result=check(root);assert.equal(result.status,1);
 assert.ok(result.report.findings.some(f=>f.path==='README.md (index)'&&f.rule==='provider token'));
}));

test('00 force-staged ignored credentials cannot bypass the public source guard',()=>fixture(root=>{
 writeFileSync(join(root,'.env.local'),marker);
 execFileSync('git',['add','-f','--','.env.local'],{cwd:root});
 const result=check(root);assert.equal(result.status,1);
 assert.ok(result.report.findings.some(f=>f.path==='.env.local'&&f.rule==='tracked file outside public manifest'));
 assert.ok(result.report.findings.some(f=>f.path==='.env.local (index)'&&f.rule==='provider token'));
}));

test('00 untracked symbolic links are rejected without reading their credential target',()=>fixture(root=>{
 writeFileSync(join(root,'.env.local'),marker);
 symlinkSync(join(root,'.env.local'),join(root,'config/local-link.json'));
 const result=check(root);assert.equal(result.status,1);
 assert.ok(result.report.findings.some(f=>f.path==='config/local-link.json'&&f.rule==='symlink must not be committed'));
 assert.ok(!result.report.findings.some(f=>f.rule==='provider token'));
}));

test('00 credential paths stay forbidden even when someone adds them to the export manifest',()=>fixture(root=>{
 const path=join(root,'config/public-source.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
 for(const name of ['token.json','video-providers.json','client_secret_desktop.json','id_ecdsa']){
  writeFileSync(join(root,name),marker);manifest.include.push(name);
 }
 writeFileSync(path,JSON.stringify(manifest));
 const result=check(root);assert.equal(result.status,1);
 for(const name of manifest.include.slice(-4))assert.ok(result.report.findings.some(f=>f.path===name&&f.rule==='private/runtime path'));
}));

test('00 local config, key variants and backup paths are ignored without hiding source examples',()=>fixture(root=>{
 const privatePaths=['.env','.env.local','.env.production.example','apps/.env.example','config/production.env','config/production.env.backup','.mcp.json','.mcp.local.json','.git-credentials','.vscode/launch.json','.config/gh/hosts.yml','credentials/video-providers.json','video-providers.json','token.json','token.yaml','tokens.json','auth.json.bak','client_secret_desktop.json','cloud-service-account.json','id_ecdsa','id_dsa','private.p8','state.sqlite3-wal','snapshot.zip','key-copy.txt.bak'];
 const result=spawnSync('git',['check-ignore','--no-index','--stdin','-z'],{cwd:root,encoding:'utf8',input:privatePaths.join('\0')+'\0'});
 assert.equal(result.status,0);assert.deepEqual(new Set(result.stdout.split('\0').filter(Boolean)),new Set(privatePaths));
 const publicPaths=['.env.example','.gitignore','README.md','package.json','package-lock.json','apps/host/main.ts','config/examples/dreamer-writing.mcp.json','config/examples/dreamer-writing.codex.toml'];
 const publicResult=spawnSync('git',['check-ignore','--no-index','--stdin','-z'],{cwd:root,encoding:'utf8',input:publicPaths.join('\0')+'\0'});
 assert.equal(publicResult.status,1);assert.equal(publicResult.stdout,'');
}));

test('00 only exact reviewed PNGs pass; unreviewed files and stale index bytes still block publication',()=>fixture(root=>{
 const path='docs/images/demo.png',full=join(root,path),config=join(root,'config/public-source.json');
 mkdirSync(join(root,'docs/images'),{recursive:true});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lGQAAAAASUVORK5CYII=','base64');
 const manifest=JSON.parse(readFileSync(config,'utf8'));manifest.include.push('docs/images');
 manifest.reviewedImages={[path]:createHash('sha256').update(png).digest('hex')};
 writeFileSync(config,JSON.stringify(manifest));writeFileSync(full,png);
 assert.equal(check(root).status,0);
 const exportRoot=mkdtempSync(join(tmpdir(),'dreamer-image-export-')),exportDir=join(exportRoot,'public-copy');
 try{
  execFileSync(process.execPath,['scripts/public-source.mjs','--output',exportDir],{cwd:root});
  assert.deepEqual(readFileSync(join(exportDir,path)),png);
 }finally{rmSync(exportRoot,{recursive:true,force:true});}
 writeFileSync(join(root,'docs/images/other.png'),png);
 assert.ok(check(root).report.findings.some(f=>f.path==='docs/images/other.png'&&f.rule==='binary source requires explicit review'));
 rmSync(join(root,'docs/images/other.png'));
 writeFileSync(full,Buffer.concat([png,Buffer.from(marker)]));
 assert.ok(check(root).report.findings.some(f=>f.path===path&&f.rule==='reviewed image content changed or invalid'));
 execFileSync('git',['add','--',path],{cwd:root});writeFileSync(full,png);
 const staged=check(root);assert.equal(staged.status,1);
 assert.ok(staged.report.findings.some(f=>f.path===path+' (index)'&&f.rule==='reviewed image content changed or invalid'));
}));
