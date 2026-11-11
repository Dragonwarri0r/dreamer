import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,chmodSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CloudVideoSettingsInput,cloudVideoIds,cloudVideoDefinitions,type CloudVideoId,type CloudVideoPublicSettings} from '../contracts/cloud-video.ts';
import {ensure} from '../contracts/foundation.ts';

type Saved=Omit<CloudVideoSettingsInput,'clearKey'>;
export class CloudVideoSettings {
 private values=new Map<CloudVideoId,Saved>();private file:string;private signature='';private fileIssue?:string;
 constructor(root:string){
  const dir=join(root,'credentials');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);this.file=join(dir,'video-providers.json');
  this.reload();
 }
 private reload(){
  if(!existsSync(this.file)){this.values.clear();this.signature='';this.fileIssue=undefined;return;}
  try{
   const stat=statSync(this.file),signature=`${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
   if(signature===this.signature)return;
   const raw:unknown=JSON.parse(readFileSync(this.file,'utf8'));ensure(Array.isArray(raw),'VALIDATION','视频凭据文件格式无效');
   const values=new Map<CloudVideoId,Saved>();
   for(const value of raw){const parsed=this.validate(value);ensure(!values.has(parsed.id),'VALIDATION','Provider 配置重复');values.set(parsed.id,parsed);}
   if((stat.mode&0o777)!==0o600)chmodSync(this.file,0o600);
   this.values=values;this.signature=signature;this.fileIssue=undefined;
  }catch{
   // An editor may temporarily leave partial JSON. Disable cloud calls until
   // repaired, without retaining stale credentials or exposing file contents.
   this.values.clear();this.signature='';this.fileIssue='视频配置文件格式有误，请修正 credentials/video-providers.json 后刷新';
  }
 }
 get(id:CloudVideoId):Saved{this.reload();return {...(this.values.get(id)??{id,enabled:false,model:cloudVideoDefinitions[id].model,region:'cn-beijing',workspace:''})};}
 endpoint(value:Saved){return value.id==='seedance'?'https://ark.cn-beijing.volces.com/api/v3':value.id==='fal-h3'?'https://queue.fal.run':value.workspace?`https://${value.workspace}.${value.region}.maas.aliyuncs.com/api/v1`:'';}
 issue(value:Saved){
  if(this.fileIssue)return this.fileIssue;
  if(!value.enabled)return '尚未启用';if(!value.apiKey)return '请填写 API Key';
  if(value.id==='wan'&&!value.workspace)return '请填写阿里云工作空间 ID';
 }
 public(id:CloudVideoId):CloudVideoPublicSettings{const v=this.get(id);return {id,enabled:v.enabled,model:v.model,region:v.region,workspace:v.workspace,configured:!!v.apiKey,endpoint:this.endpoint(v),issue:this.issue(v)};}
 list(){return cloudVideoIds.map(id=>this.public(id));}
 private validate(input:unknown){
  // Never return Zod issue details here: invalid values may contain credentials.
  const parsed=CloudVideoSettingsInput.safeParse(input);ensure(parsed.success,'VALIDATION','视频配置格式无效，请检查模型、地域、工作空间和 Key');
  const v=parsed.data;
  ensure(v.id!=='wan'||['wan3.0-video','wan3.0-video-prime'].includes(v.model),'VALIDATION','请选择万相 3.0 标准版或加速版');
  ensure(v.id!=='seedance'||/^(doubao-seedance-2-5-[0-9]+|ep-[\w-]+)$/.test(v.model),'VALIDATION','请填写 Seedance 2.5 模型 ID 或其推理接入点 ep-ID');
  ensure(v.id!=='fal-h3'||v.model==='minimax/h3-max','VALIDATION','当前 fal 接入支持 minimax/h3-max');
  ensure(!(v.clearKey&&v.apiKey),'VALIDATION','清除 Key 时不要同时填写新 Key');
  return v;
 }
 save(input:unknown){
  const v=this.validate(input);this.reload();ensure(!this.fileIssue,'VALIDATION',this.fileIssue??'视频配置文件格式无效');
  const {clearKey,...fields}=v,old=this.get(v.id),next={...fields,apiKey:clearKey?undefined:v.apiKey||old.apiKey};
  const values=new Map(this.values);values.set(v.id,next);
  const temp=this.file+'.'+randomUUID();writeFileSync(temp,JSON.stringify([...values.values()],null,2),{mode:0o600,flag:'wx'});renameSync(temp,this.file);this.values=values;return this.public(v.id);
 }
}
