import { stable, type Ref } from '../../contracts/foundation.ts';
import type { ScriptPlanData, ScriptNode } from '../../contracts/interactive-script.ts';
import type { ScriptRelease } from '../../contracts/experience.ts';
import { references, type ReferenceReader } from '../modules/authoring.ts';

export type ImpactType = 'variable' | 'rule' | 'text' | 'audio' | 'visual' | 'metadata';
export type ScriptImpactItem = { releaseId: string; title: string; type: ImpactType; nodeId?: string; nodeIds: string[]; variableKeys: string[]; fields: string[]; message: string; regenerate: boolean; sourceRef?: Ref; currentRef?: Ref };
const metadata = new Set(['title', 'notes', 'order', 'outlineOrder', 'description', 'tags', 'number', 'volume']);
const labels: Record<ImpactType,string> = { variable:'变量',rule:'规则',text:'正文',audio:'声音',visual:'画面',metadata:'纯元数据' };
const actions: Record<ImpactType,string> = {
  variable:'重验读写权限、取值范围、分支和动态读集；只在新版本中按改变的输入准备动态内容',
  rule:'重验路线、结果效果和互动时码；按新规则重新模拟，已有媒体由内容一致性决定是否复用',
  text:'重新检查正文和固定事实；重绑来源后评估关联镜头、对白与字幕，按需重制',
  audio:'复核对白、说话者与原生音轨；重新制作受影响声音或带原声的视频，并校准字幕时码',
  visual:'复核角色参考、画面动作与镜头；仅为受影响镜头生成新候选，再合成新版本',
  metadata:'只更新名称、说明或排列，无需调用模型或重制媒体',
};
const different = (a: unknown,b: unknown) => stable(a)!==stable(b);
const fields = (a:any={},b:any={}) => [...new Set([...Object.keys(a??{}),...Object.keys(b??{})])].filter(key=>different(a?.[key],b?.[key]));
const unique = <T>(values:T[]) => [...new Set(values)];
function variableUses(value:unknown, keys:Set<string>):string[]{
  const found=new Set<string>();
  function walk(item:any){if(typeof item==='string'){for(const key of keys)if(item===key||item.includes('{{'+key+'}}')||new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(item))found.add(key);}else if(Array.isArray(item))item.forEach(walk);else if(item&&typeof item==='object')Object.values(item).forEach(walk);}
  walk(value);return [...found];
}
function nodeCategories(before:ScriptNode|undefined,after:ScriptNode|undefined):ImpactType[]{
  if(!before||!after)return ['rule',...(before?.type==='segment'||after?.type==='segment'?['text' as const]:[])];
  const changed=fields(before,after),types=new Set<ImpactType>();
  if(changed.every(key=>metadata.has(key)))return ['metadata'];
  if(changed.some(key=>metadata.has(key)))types.add('metadata');
  if(changed.some(key=>['type','next','cases','fallback','requires','commitEffects','completionEffects','activityId','endingKey','chapterId'].includes(key)))types.add('rule');
  if(changed.includes('summary'))types.add('text');
  if(changed.includes('sourceSceneRefs'))types.add('text');
  if(before.type==='segment'&&after.type==='segment'&&different(before.contentSpec,after.contentSpec)){
    const a:any=before.contentSpec,b:any=after.contentSpec;
    if(a.mode!==b.mode){types.add('rule');types.add('text');}
    if(different(a.media,b.media)||different(a.variants?.map((v:any)=>v.media),b.variants?.map((v:any)=>v.media))){types.add('visual');types.add('audio');}
    if(different(a.text,b.text))types.add('text');
    if(different(a.reads,b.reads))types.add('variable');
    if(different(a.variants?.map((v:any)=>({id:v.id,when:v.when,outcomeId:v.outcomeId})),b.variants?.map((v:any)=>({id:v.id,when:v.when,outcomeId:v.outcomeId}))))types.add('rule');
    const ga=a.generationContract,gb=b.generationContract;
    if(different(ga,gb)){
      if(!ga||!gb){types.add('rule');types.add('text');}
      else for(const key of fields(ga,gb)){
        if(key==='reads')types.add('variable');
        else if(['narrativeGoal','fixedFacts','allowedChanges','sourceRefs','scope'].includes(key))types.add('text');
        else if(key==='resourceRefs'){types.add('visual');types.add('audio');}
        else if(key==='outcomes'){
          if(different(ga.outcomes.map((o:any)=>({id:o.id,narrativeRequirement:o.narrativeRequirement})),gb.outcomes.map((o:any)=>({id:o.id,narrativeRequirement:o.narrativeRequirement}))))types.add('text');
          if(different(ga.outcomes.map((o:any)=>({id:o.id,postconditions:o.postconditions,completionEffects:o.completionEffects})),gb.outcomes.map((o:any)=>({id:o.id,postconditions:o.postconditions,completionEffects:o.completionEffects}))))types.add('rule');
        }else types.add('rule');
      }
    }
  }
  return types.size?[...types]:['rule'];
}
function dependencyCategories(kind:string,before:any,after:any,changed:string[]):ImpactType[]{
  if(!changed.length)return ['rule'];
  const types=new Set<ImpactType>(),meta=changed.filter(key=>metadata.has(key)&&!(kind==='resource'&&key==='description'));
  if(meta.length)types.add('metadata');
  const content=changed.filter(key=>!meta.includes(key));if(!content.length)return [...types];
  if(kind==='scene'){
    if(content.some(key=>['blocks','synopsis','storyState'].includes(key)))types.add('text');
    if(content.includes('blocks')){
      const blocks=unique([...before.blocks??[],...after.blocks??[]].map((b:any)=>b.id));
      for(const id of blocks){const a=before.blocks?.find((b:any)=>b.id===id),b=after.blocks?.find((b:any)=>b.id===id);if(!different(a,b))continue;types.add(a?.type==='dialogue'||b?.type==='dialogue'?'audio':'visual');}
    }
    if(content.some(key=>['location','time','bindings','storyState'].includes(key)))types.add('visual');
  }else if(kind==='chapter'||kind==='knowledge')types.add('text');
  else if(kind==='resource')types.add(before.type==='voice'||after.type==='voice'?'audio':'visual');
  else if(kind==='shot'){
    if(content.includes('sound'))types.add('audio');
    if(content.some(key=>key!=='sound'))types.add('visual');
  }else if(kind==='artifact'){
    const media=after.mediaType??before.mediaType??'';if(!media.startsWith('image/'))types.add('audio');if(!media.startsWith('audio/'))types.add('visual');
  }else if(kind==='build'||kind==='cut'){types.add('visual');types.add('audio');}
  else types.add('rule');
  return types.size?[...types]:['text'];
}

export function scriptReleaseImpact(release:ScriptRelease,current:ScriptPlanData,read:ReferenceReader,latest:ReferenceReader,pid:string){
  const old=release.snapshot,items:ScriptImpactItem[]=[],nodes=unique([...old.nodes.map(n=>n.id),...current.nodes.map(n=>n.id)]);
  const keys=new Set([...old.variables.map(v=>v.key),...current.variables.map(v=>v.key)]);
  const uses=(plan:ScriptPlanData,node:ScriptNode)=>({...node,activity:node.type==='activity'?plan.activities.find(a=>a.id===node.activityId):undefined,cues:plan.cues.filter(c=>c.segmentNodeId===node.id||c.activityNodeId===node.id)});
  const affectedVariables=(wanted:string[])=>nodes.filter(id=>[old,current].some(plan=>{const n=plan.nodes.find(n=>n.id===id);return n&&variableUses(uses(plan,n),new Set(wanted)).length>0;}));
  const add=(title:string,types:ImpactType[],nodeIds:string[],changed:string[],variableKeys:string[]=[],sourceRef?:Ref,currentRef?:Ref)=>{
    for(const type of unique(types))items.push({releaseId:release.id,title:`${labels[type]} · ${title}`,type,nodeId:nodeIds.length===1?nodeIds[0]:undefined,nodeIds:unique(nodeIds),variableKeys,fields:changed,sourceRef,currentRef,regenerate:['text','audio','visual'].includes(type),message:`${actions[type]}。旧发布和已有体验继续使用固定版本，不自动生成或迁移。`});
  };
  const changedNodeIds=nodes.filter(id=>different(old.nodes.find(n=>n.id===id),current.nodes.find(n=>n.id===id)));
  for(const id of changedNodeIds){const a=old.nodes.find(n=>n.id===id),b=current.nodes.find(n=>n.id===id);add(b?.title??a?.title??'已移除节点',nodeCategories(a,b),[id],fields(a,b),unique([...variableUses(a,keys),...variableUses(b,keys)]));}
  const changedVariables=[...keys].filter(key=>different(old.variables.find(v=>v.key===key),current.variables.find(v=>v.key===key)));
  for(const key of changedVariables){const a=old.variables.find(v=>v.key===key),b=current.variables.find(v=>v.key===key),changed=fields(a,b);add(b?.label??a?.label??key,changed.every(k=>k==='label')?['metadata']:unique([...(changed.includes('allowedWriters')?['rule' as const]:[]),...(changed.some(k=>!['label','allowedWriters'].includes(k))?['variable' as const]:[])]),affectedVariables([key]),changed,[key]);}
  for(const id of unique([...old.activities.map(a=>a.id),...current.activities.map(a=>a.id)])){
    const a=old.activities.find(a=>a.id===id),b=current.activities.find(a=>a.id===id);if(!different(a,b))continue;
    const changed=fields(a,b),types:ImpactType[]=changed.every(k=>k==='label')?['metadata']:unique([...(changed.some(k=>['config','presentation'].includes(k))?['text' as const]:[]),...(changed.some(k=>!['label','config','presentation'].includes(k))?['rule' as const]:[])]);
    add(b?.label??a?.label??'活动',types,nodes.filter(nodeId=>[old,current].some(plan=>plan.nodes.some(n=>n.id===nodeId&&n.type==='activity'&&n.activityId===id))),changed,unique([...variableUses(a,keys),...variableUses(b,keys)]));
  }
  if(different(old.cues,current.cues))add('互动时码与截止点',['rule'],unique([...old.cues,...current.cues].flatMap(c=>[c.segmentNodeId,c.activityNodeId])),['cues']);
  if(different(old.policy,current.policy)){add('生成与审阅策略',['rule'],nodes,fields(old.policy,current.policy));if(different(old.policy.executionProfiles,current.policy.executionProfiles))add('媒体执行规格',['visual','audio'],nodes.filter(id=>[old,current].some(p=>p.nodes.some(n=>n.id===id&&n.type==='segment'))),['executionProfiles']);}
  if(different(old.entryNodeId,current.entryNodeId)||different(old.chapterRefs,current.chapterRefs))add('入口与章节顺序',['rule'],unique([old.entryNodeId,current.entryNodeId]),['entryNodeId','chapterRefs']);
  const top=fields(old,current).filter(key=>['title','branchOf'].includes(key));if(top.length)add(current.title,['metadata'],[],top);
  const closureCache=new Map<string,Set<string>>();
  const closure=(ref:Ref):Set<string>=>{const key=stable(ref),cached=closureCache.get(key);if(cached)return cached;const result=new Set<string>(),pending=[ref];closureCache.set(key,result);while(pending.length&&result.size<20000){const next=pending.pop()!,identity=`${next.kind}:${next.id}`;if(result.has(identity))continue;result.add(identity);try{pending.push(...references(read(next,pid).data));}catch{}}return result;};
  const related=(ref:Ref)=>nodes.filter(id=>[old,current].some(plan=>{const node=plan.nodes.find(n=>n.id===id);if(!node)return false;const direct=[...references(uses(plan,node)),...plan.chapterRefs.filter(r=>r.id===node.chapterId)];return direct.some(r=>closure(r).has(`${ref.kind}:${ref.id}`));}));
  const changedDependencies=release.dependencyRefs.flatMap<{before:Ref;current?:Ref;missing?:boolean;fields:string[];nodeIds:string[];types:ImpactType[]}>(ref=>{
    try{const row=latest(ref,pid),currentRef={...ref,seq:row.seq};if(row.seq===ref.seq)return [];
      const before=read(ref,pid).data,changed=fields(before,row.data),types=dependencyCategories(ref.kind,before,row.data,changed),nodeIds=related(ref);
      add(row.data.title??`${ref.kind} ${ref.id}`,types,nodeIds,changed,[],ref,currentRef);return [{before:ref,current:currentRef,fields:changed,nodeIds,types}];
    }catch{const nodeIds=related(ref);add(`${ref.kind} 来源不可读取`,['rule'],nodeIds,[],[],ref);return [{before:ref,missing:true,fields:[],nodeIds,types:['rule']}];}
  });
  return {items,release:{id:release.id,scriptSeq:release.scriptRef.seq,manifestHash:release.manifestHash,changed:different(old,current)||changedDependencies.length>0,scriptChanged:different(old,current),changedNodeIds,changedVariables,changedDependencies,affectedNodeIds:unique(items.flatMap(item=>item.nodeIds)),categories:unique(items.map(item=>item.type))}};
}
