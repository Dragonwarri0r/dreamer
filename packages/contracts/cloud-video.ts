import {z} from 'zod';
import type {ProfileConstraints,RenderIntent} from './production.ts';

export const CloudVideoId=z.enum(['seedance','wan','fal-h3']);
export type CloudVideoId=z.infer<typeof CloudVideoId>;
export const cloudVideoIds=CloudVideoId.options;
export const isCloudVideo=(id:string):id is CloudVideoId=>cloudVideoIds.includes(id as CloudVideoId);
export const wanRegions=['cn-beijing','ap-southeast-1','ap-northeast-1','eu-central-1','us-east-1','cn-hongkong'] as const;
export const cloudVideoDefinitions={
 seedance:{title:'Seedance 2.5 · 火山方舟',model:'doubao-seedance-2-5-260628',keyUrl:'https://ark.volcengine.com/region:cn-beijing/apiKey',docsUrl:'https://console.volcengine.com/ark/region:cn-beijing/docs/create-video-generation-task-api',profiles:['720p','1080p','480p'],fps:24,minSeconds:4,maxSeconds:30,maxPrompt:20000},
 wan:{title:'万相 3.0 · 阿里云',model:'wan3.0-video',keyUrl:'https://bailian.console.aliyun.com/',docsUrl:'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference',profiles:['720p','1080p','480p'],fps:30,minSeconds:2,maxSeconds:30,maxPrompt:20000},
 'fal-h3':{title:'H3 Max · fal 云端',model:'minimax/h3-max',keyUrl:'https://fal.ai/dashboard/keys',docsUrl:'https://fal.ai/models/minimax/h3-max/text-to-video/api',profiles:['768p','1080p','480p'],fps:24,minSeconds:5,maxSeconds:15,maxPrompt:4000},
} as const;
export const CloudVideoSettingsInput=z.strictObject({
 id:CloudVideoId,enabled:z.boolean(),model:z.string().trim().min(1).max(120).regex(/^[\w./-]+$/),
 workspace:z.string().trim().max(100).regex(/^[a-zA-Z0-9-]*$/).default(''),region:z.enum(wanRegions).default('cn-beijing'),
 apiKey:z.string().trim().max(4096).refine(v=>!/[\r\n\x00-\x1f\x7f]/.test(v)).optional(),clearKey:z.boolean().default(false),
});
export type CloudVideoSettingsInput=z.infer<typeof CloudVideoSettingsInput>;
export type CloudVideoPublicSettings={id:CloudVideoId;enabled:boolean;model:string;workspace:string;region:typeof wanRegions[number];configured:boolean;endpoint:string;issue?:string};
export function cloudDimensions(profile:string,ratio='9:16'){
 const short=Number.parseInt(profile),long=short===768?1344:Math.ceil(short*16/9/2)*2;
 return ratio==='1:1'?{width:short===768?1024:Math.round(short*4/3),height:short===768?1024:Math.round(short*4/3)}:ratio==='16:9'?{width:long,height:short}:{width:short,height:long};
}
export function cloudRatio(profile:string,width:number,height:number){return ['9:16','16:9','1:1'].find(r=>{const d=cloudDimensions(profile,r);return d.width===width&&d.height===height;});}
export function cloudConstraints(id:CloudVideoId,profile:string):ProfileConstraints{
 const d=cloudVideoDefinitions[id];return {...cloudDimensions(profile),frames:d.fps*5,fps:d.fps,durationSeconds:5,durationRange:[d.minSeconds,d.maxSeconds],aspectRatios:['9:16','16:9','1:1'],audio:true,final:true,minReferences:0,maxReferences:2,firstLastFramesForTwo:true,referenceMediaTypes:['image/png','image/jpeg'],maxPromptCharacters:d.maxPrompt,promptEncoding:'unicode'};
}
export function cloudIntentIssue(intent:RenderIntent):string|undefined{
 if(!isCloudVideo(intent.provider))return;const def=cloudVideoDefinitions[intent.provider],c=intent.constraints;
 if(!(def.profiles as readonly string[]).includes(intent.profile)||!cloudRatio(intent.profile,c.width,c.height))return '请选择该云模型的分辨率与画幅预设';
 if(!Number.isInteger(c.durationSeconds)||c.durationSeconds<def.minSeconds||c.durationSeconds>def.maxSeconds)return `该模型时长须为 ${def.minSeconds}–${def.maxSeconds} 的整数秒`;
 if(!c.audio||c.fps!==def.fps)return `该模型须保留原生音频，帧率为 ${def.fps}fps`;
 if(!intent.prompt.trim()||[...intent.prompt].length>def.maxPrompt)return `生成描述不能为空，且不能超过 ${def.maxPrompt} 字符`;
 if(intent.references.length>2||c.firstLastFrames!==(intent.references.length===2))return '最多两张参考图；两张图须明确为首帧和尾帧';
}
