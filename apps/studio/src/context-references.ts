import type {Ref} from '../../../packages/contracts/foundation.ts';

export const contextRefKey=(ref:Ref)=>`${ref.kind}:${ref.id}:${ref.seq}`;
export const sameContextRef=(a:Ref,b:Ref)=>contextRefKey(a)===contextRefKey(b);
export function addContextRef(refs:Ref[],ref:Ref){return refs.some(item=>sameContextRef(item,ref))?refs:[...refs,ref];}
/** A reference row is one fixed version, not every version of the object. */
export function removeContextRef(refs:Ref[],index:number){return refs.filter((_,i)=>i!==index);}

export const contextKindLabels:Record<Ref['kind'],string>={project:'工程',chapter:'章节',episode:'制作单',scene:'场景',resource:'资源设定',knowledge:'资料',shot:'镜头',thread:'会话',work:'工作项',job:'生成任务',artifact:'素材',cut:'剪辑',build:'成片',change:'修订提案',note:'审阅意见',script:'互动剧本'};
export function currentReference(state:any,ref:Ref){
 if(ref.kind==='project')return state.project?.id===ref.id?state.project:undefined;
 const collection=ref.kind==='knowledge'?'knowledge':ref.kind==='work'?'works':`${ref.kind}s`;
 return state[collection]?.find((row:any)=>row.id===ref.id);
}
