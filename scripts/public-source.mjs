import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const manifest=JSON.parse(readFileSync(join(root,'config/public-source.json'),'utf8'));
const files=new Map(), findings=[];
const forbidden=/(^|\/)(?:node_modules|data|\.local|test-results|dist|credentials|secrets|backups|exports|\.codex|\.aws|\.ssh|\.venv|__pycache__)(\/|$)|(^|\/)(?:auth\.json|token|\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|id_rsa.*|id_ed25519.*)$|\.(?:pem|key|p12|pfx|jks|keystore|sqlite\d*(?:-\w+)?|db(?:-\w+)?|safetensors|gguf|mp4|wav|mp3|zip|tar|gz|pyc)$|\.local\.(?:json|toml)$/i;
const privateName=/^(?:\.git-credentials|\.mcp(?:\..*)?\.json|auth\.json.*|token(?:\.(?:json|ya?ml|txt))?|tokens\.json|(?:credentials|secrets)\.(?:json|ya?ml)|video-providers\.json|client_secret.*\.json|.*service[-_]account.*\.json|id_(?:ecdsa|dsa).*|.*\.env(?:\..*)?)$/i;
const privateExtra=/(^|\/)(?:\.config|\.vscode|\.idea|\.cache|coverage|releases)(\/|$)|\.(?:token|p8|tgz|7z|rar|bak|old|orig|swp|swo)$|~$|\.local\.(?:ya?ml|ini|conf)$/i;
function allowedPath(path){return path==='.env.example'||!forbidden.test(path)&&!privateName.test(basename(path))&&!privateExtra.test(path);}
function fail(path,rule,line){findings.push({path,rule,...(line?{line}:{})});}
function collect(path){
 if(isAbsolute(path)||path.split('/').includes('..')){fail(path,'invalid manifest path');return;}
 // Finder metadata is never source, even inside an explicitly included directory.
 if(basename(path)==='.DS_Store')return;
 if(!allowedPath(path)){fail(path,'private/runtime path');return;}
 const full=join(root,path);
 if(!existsSync(full)){fail(path,'missing source');return;}
 const stat=lstatSync(full);
 if(stat.isSymbolicLink()){fail(path,'symlink must not be exported');return;}
 if(stat.isDirectory()){for(const child of readdirSync(full).sort())collect(`${path}/${child}`);return;}
 if(!stat.isFile()||stat.size>4_000_000){fail(path,'unexpected or oversized source file');return;}
 files.set(path,readFileSync(full));
}

// These exact non-working fixture values were reviewed; no whole-file exclusions.
const fakeTokens=new Map([
 ['scripts/browser-cloud-video.ts',new Set(['sk-'+'ui-test-not-a-real-key'])],
 ['tests/03-agent-model-config.test.ts',new Set(['secret-sentinel','broken-secret-sentinel'])],
 ['tests/11-experience-archive.test.ts',new Set(['DO-NOT-BACK-UP-KEY','DO-NOT-EXPORT'])],
 ['tests/03-writing-mcp.test.ts',new Set(['http://'+'user:secret@'+'localhost:4330'])],
 ['tests/06-cloud-video.test.ts',new Set(['sk-'+'test-cloud-secret-do-not-echo','sk-'+'edited-file-key','sk-'+'partial-secret','https://'+'user:pass@'+'example.com'])],
 ['tests/11-local-runtime.test.ts',new Set(['http://'+'user:secret@'+'127.0.0.1:1234'])],
]);
const patterns=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
 ['provider token',/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35})\b/g],
 ['JWT',/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g],
 ['credential URL',/https?:\/\/[^\s/@:"'<>]+:[^\s/@"'<>]+@[^\s/"'<>]+/g],
];
function scan(path,bytes,label=path){
 // Screenshots need visual review: only the exact reviewed PNG bytes may pass.
 const reviewedImage=manifest.reviewedImages?.[path];
 if(reviewedImage){
  if(!path.startsWith('docs/images/')||!path.endsWith('.png')||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||createHash('sha256').update(bytes).digest('hex')!==reviewedImage)fail(label,'reviewed image content changed or invalid');
  return;
 }
 const text=bytes.toString('utf8');
 if(bytes.includes(0)){fail(label,'binary source requires explicit review');return;}
 for(const [rule,pattern] of patterns){
  for(const match of text.matchAll(pattern)){
   if(fakeTokens.get(path)?.has(match[0]))continue;
   fail(label,rule,text.slice(0,match.index).split('\n').length);
  }
 }
 for(const match of text.matchAll(/["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["']([^"'\n]{12,})["']/gi)){
  if(!fakeTokens.get(path)?.has(match[1]))fail(label,'credential literal',text.slice(0,match.index).split('\n').length);
 }
 // A personal checkout path is a portability/privacy issue, never print its value.
 for(const match of text.matchAll(/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g))fail(label,'personal absolute path',text.slice(0,match.index).split('\n').length);
}
for(const path of manifest.include)collect(path);
if(existsSync(join(root,'LICENSE')))collect('LICENSE');
for(const [path,bytes] of files)scan(path,bytes);
let gitScope='no Git metadata; history not audited';
if(existsSync(join(root,'.git'))){
 try{
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const path of tracked){
   if(!files.has(path))fail(path,'tracked file outside public manifest');
   // Inspect the index as well: working-tree cleanup alone cannot clean a staged secret.
   scan(path,execFileSync('git',['show',`:${path}`],{cwd:root,maxBuffer:8_000_000}),`${path} (index)`);
  }
  const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const path of untracked){
   if(files.has(path))continue; // Included working-tree files have already been scanned.
   fail(path,'untracked file outside public manifest');
   const full=join(root,path),stat=lstatSync(full);
   if(stat.isSymbolicLink()){fail(path,'symlink must not be committed');continue;}
   if(!stat.isFile()||stat.size>4_000_000){fail(path,'unexpected or oversized Git candidate');continue;}
   scan(path,readFileSync(full));
  }
  gitScope='public working tree, index and unignored untracked files checked; history still requires a dedicated scan';
 }catch{fail('.git','unable to inspect complete Git index');}
}
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--output'))throw new Error('Usage: npm run source:check OR npm run source:export -- /absolute/new-directory');
const report={files:files.size,bytes:[...files.values()].reduce((n,b)=>n+b.length,0),gitScope,licensePresent:existsSync(join(root,'LICENSE')),findings};
console.log(JSON.stringify(report,null,2));
if(findings.length){process.exitCode=1;}else if(args[0]==='--output'){
 // Canonicalize existing ancestors too: /tmp aliases and symlinked parents
 // must not bypass the prohibition on writing into the source workspace.
 let ancestor=resolve(args[1]);const tail=[];
 while(!existsSync(ancestor)){tail.unshift(basename(ancestor));ancestor=dirname(ancestor);}
 const output=resolve(realpathSync(ancestor),...tail),rel=relative(root,output);
 if(!isAbsolute(args[1])||!rel||(!rel.startsWith('..')&&!isAbsolute(rel))||existsSync(output))throw new Error('Output must be a new absolute directory outside the source workspace');
 mkdirSync(output,{recursive:true,mode:0o700});
 for(const [path,bytes] of files){mkdirSync(dirname(join(output,path)),{recursive:true});writeFileSync(join(output,path),bytes,{flag:'wx',mode:path.endsWith('.sh')?0o755:0o644});}
 console.log(`Local review copy created: ${output}. This is not a release approval; license, history, dependencies and content rights still require review.`);
}
