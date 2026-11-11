import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {narrativeSkills} from '../packages/contracts/narrative-skills.ts';

/** Markdown is a generated, inspectable view of the same instructions the Host injects. */
export function renderWritingSkill(skill:typeof narrativeSkills[number]):string{
 return [
  '---',`name: ${skill.id}`,`description: ${JSON.stringify(skill.description)}`,'---','',
  '<!-- Generated from packages/contracts/narrative-skills.ts. Edit that source and run scripts/export-writing-skills.ts. -->','',
  `# ${skill.title}`,'',skill.instructions.replaceAll('\n','\n\n'),'',
  '维护与复核参考（不自动注入，不表示运行中的 Agent 已读取）：',
  '- [方法来源及职责](../../docs/writing-skills.md)：维护规范或追溯方法时查看。',
  '- 连载结构与信息分配研究保留在维护者工作区，公开方法与来源见上方文档。',
  '- 本机专项试写材料不随公开源码分发；需要时由维护者提供，不套作其他小说的模板。',''
 ].join('\n');
}

export function exportWritingSkills(check=false):string[]{
 const changed:string[]=[];
 for(const skill of narrativeSkills){
  const path=fileURLToPath(new URL(`../skills/${skill.id}/SKILL.md`,import.meta.url));
  const expected=renderWritingSkill(skill);
  let current:string|undefined;
  try{current=readFileSync(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(current===expected)continue;
  changed.push(path);
  if(!check){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,expected);}
 }
 return changed;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const check=process.argv.includes('--check'),changed=exportWritingSkills(check);
 if(check&&changed.length){console.error(`Skill views differ from runtime instructions:\n${changed.join('\n')}`);process.exitCode=1;}
 else console.log(check?'Writing skill views match runtime instructions.':`Updated ${changed.length} writing skill views.`);
}
