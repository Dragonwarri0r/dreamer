import {isCloudVideo} from './cloud-video.ts';
import {h3Profiles} from './video-preference.ts';
import type {ShotData} from './storyboard.ts';
import {z} from 'zod';
import {Ref} from './foundation.ts';

/** Only these author-approved roles may become actual video conditioning frames. */
export const VideoFrameReference=z.strictObject({purpose:z.enum(['start','end']),artifact:Ref.refine(ref=>ref.kind==='artifact','首尾帧必须引用固定素材')});
export type VideoFrameReference=z.infer<typeof VideoFrameReference>;
export const ProviderPrompts=z.partialRecord(z.enum(['h3','ltx','seedance','wan','fal-h3']),z.string().max(30000));

/** No browser objects or mutable author Shot are needed to compile runtime narration. */
export function runtimeProductionPrompt(input:{provider:string;goal:string;action:string;sound:string;providerPrompts?:Record<string,string>;dialogue:{speaker:string;text:string}[];resources:{title:string;type:string;description:string;requirements:string}[];sceneContext?:{location:string;time:string;blocks:{type:string;text:string}[]};fixedFacts?:{key:string;text:string}[]}){
 const spoken=input.dialogue.map(block=>`${block.speaker||'角色'}：${block.text}`).join('\n');
 const original=input.providerPrompts?.[input.provider];
 let prompt=original??(input.provider==='h3'?`integrated_multimodal_description: ${input.goal}\n${input.action}\n${spoken}\n\noverall_soundscape: ${input.sound||'保留场景自然声音'}\n\nnon_diegetic_music: N/A`:[input.goal,input.action,input.sound,spoken].filter(Boolean).join('\n'));
 // Preserve every approved line even when a model-specific prompt omits it.
 const missing=input.dialogue.filter(block=>!prompt.includes(block.text));
 if(missing.length)prompt+='\n原文对白（逐字保留）：\n'+missing.map(block=>`${block.speaker||'角色'}：${block.text}`).join('\n');
 if(input.sceneContext)prompt+='\n镜头所属场景的冻结连续性约束（不得移入其他场景，不新增画外角色）：\n'+JSON.stringify(input.sceneContext);
 if(input.fixedFacts?.length)prompt+='\n必须保留的固定事实：\n'+input.fixedFacts.map(fact=>`${fact.key}：${fact.text}`).join('\n');
 if(input.resources.length)prompt+='\n固定资源设定（文字约束；不代表已输入角色参考图）：\n'+input.resources.map(resource=>JSON.stringify(resource)).join('\n');
 return isCloudVideo(input.provider)?cloudProductionPrompt(prompt):prompt;
}

const text=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value:undefined;
// Official three-part native audio/video prompt: MiniMax-H3/skills/h3-prompt-writing/references/base-en.txt
export const h3PromptFields=['integrated_multimodal_description','overall_soundscape','non_diegetic_music'] as const;
export function missingH3PromptFields(prompt:string){return h3PromptFields.filter(field=>!new RegExp(`(?:^|\\n)\\s*${field}\\s*:`).test(prompt));}

export function readProductionNotes(raw:string):{structured:boolean;notes:Record<string,unknown>;productionPrompt:string}{
 try{const value=JSON.parse(raw);if(value&&typeof value==='object'&&!Array.isArray(value))return {structured:true,notes:value,productionPrompt:typeof value.productionPrompt==='string'?value.productionPrompt:''};}catch{}
 return {structured:false,notes:{},productionPrompt:''};
}
/** Converting plain notes is an explicit UI action; retain the original text. */
export function updateProductionPrompt(raw:string,prompt:string){
 const current=readProductionNotes(raw);
 return JSON.stringify({...(current.structured?current.notes:{productionNotes:raw}),productionPrompt:prompt},null,2);
}
export function updateImagePrompt(raw:string,prompt:string){
 const current=readProductionNotes(raw);
 return JSON.stringify({...(current.structured?current.notes:{productionNotes:raw}),imagePrompt:prompt},null,2);
}
export function updateProviderPrompt(raw:string,provider:string,prompt:string){
 const current=readProductionNotes(raw),notes=current.structured?current.notes:{productionNotes:raw};
 const prompts=notes.providerPrompts&&typeof notes.providerPrompts==='object'&&!Array.isArray(notes.providerPrompts)?notes.providerPrompts as Record<string,unknown>:{};
 // Legacy H3 editors still read productionPrompt; keep that entry in sync.
 return JSON.stringify({...notes,...(provider==='h3'?{productionPrompt:prompt}:{}),providerPrompts:{...prompts,[provider]:prompt}},null,2);
}

/** Read saved authoring data without converting objects into generation prompts. */
export function shotProductionInput(shot:ShotData,provider:string){
 const {notes}=readProductionNotes(shot.notes);
 const start=shot.panels.find(p=>p.purpose==='start'&&p.artifact),end=shot.panels.find(p=>p.purpose==='end'&&p.artifact);
 const video=provider==='h3'||provider==='ltx'||isCloudVideo(provider);
 const referenceIds=video?(start?[start.artifact!.id,...(end?[end.artifact!.id]:[])]:[]):provider==='tts'?[]:shot.panels.filter(p=>p.artifact).slice(0,1).map(p=>p.artifact!.id);
 const picture=typeof notes.imagePrompt==='string'?notes.imagePrompt:text(start?.description)??text(shot.panels.find(p=>p.purpose!=='reference')?.description)??text(shot.action)??'';
 const providerPrompts=notes.providerPrompts&&typeof notes.providerPrompts==='object'&&!Array.isArray(notes.providerPrompts)?notes.providerPrompts as Record<string,unknown>:{};
 const specific=typeof providerPrompts[provider]==='string'?providerPrompts[provider] as string:undefined;
 let prompt=provider==='h3'||isCloudVideo(provider)?specific??text(notes.productionPrompt)??text(notes.motionPrompt)??picture:provider==='ltx'?text(notes.motionPrompt)??picture:provider==='tts'?text(notes.voice)??text(shot.sound)??'':picture;
 if(isCloudVideo(provider))prompt=cloudProductionPrompt(prompt);
 const warnings:string[]=[];
 if(video&&(['start','end'] as const).some(purpose=>shot.panels.filter(p=>p.purpose===purpose&&p.artifact).length>1))warnings.push('存在多张有效首帧或尾帧，已按关键帧列表顺序选择第一张；请检查下方参考图，或回到镜头调整用途。');
 if(video&&!start&&shot.panels.some(p=>p.artifact))warnings.push('未自动带入参考图：请先把本镜头开场画面标记为首帧；角色参考或单独尾帧不会作为首帧。');
 const framePlan=notes.firstFramePlan&&typeof notes.firstFramePlan==='object'?notes.firstFramePlan as Record<string,unknown>:undefined;
 if(video&&!start&&framePlan?.requiresBeforeGeneration===true)warnings.push('本镜按首帧生成视频规划，但实际首帧尚未绑定。请先生成或导入首帧；若改为纯文字生成，请同时调整描述与连续性方案。');
 if(provider==='h3'&&missingH3PromptFields(prompt).length)warnings.push('已保留现有描述；原生音画还需补齐画面与对白、整体声景、配乐三段。系统不会自动改用 TTS。');
 return {prompt,referenceIds,warnings};
}

/** Strip only known local profile boilerplate; keep every spoken word and other instructions. */
export function cloudProductionPrompt(prompt:string){
 const known=new Set(Object.values(h3Profiles).map(p=>`Native portrait framing ${p.width}x${p.height} at ${p.fps}fps.`));
 const durations=new Set(Object.values(h3Profiles).map(p=>`The clip is ${p.frames} frames at ${p.fps}fps; keep the ending naturally alive through the last frame.`));
 return prompt.split(/(<d>[\s\S]*?(?:<\/d>|$))/gi).map((part,index)=>index%2?part.replace(/^<d>\[Chinese\]([\s\S]*?)<\/d>$/i,'中文对白：“$1”'):part.replace(/Native portrait framing \d+x\d+ at \d+fps\./g,match=>known.has(match)?'':match).replace(/The clip is \d+ frames at \d+fps; keep the ending naturally alive through the last frame\./g,match=>durations.has(match)?'Keep the ending naturally alive through the last frame.':match)).join('');
}
