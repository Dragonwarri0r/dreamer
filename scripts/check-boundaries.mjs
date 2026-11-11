import {readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';
function files(root){return readdirSync(root,{withFileTypes:true}).flatMap(d=>d.isDirectory()?files(join(root,d.name)):[join(root,d.name)]);}
const errors=[];for(const file of files('packages/core').filter(f=>f.endsWith('.ts'))){const text=readFileSync(file,'utf8');if(/from ['"](?:node:(?:fs|child_process|sqlite|http)|[^'"]*infra\/)/.test(text))errors.push(`${file}: domain imports infrastructure`);}
for(const file of files('apps/studio/src').filter(f=>/\.tsx?$/.test(f))){if(/from ['"][^'"]*(?:packages\/core|packages\/infra|apps\/host)/.test(readFileSync(file,'utf8')))errors.push(`${file}: browser imports Host implementation`);}
if(errors.length)throw new Error(errors.join('\n'));console.log('领域 / 基础设施 / 浏览器边界检查通过');
