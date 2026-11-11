import type {Ref} from '../../../packages/contracts/foundation.ts';
import type {WritingMode} from '../../../packages/contracts/writing.ts';

export type {WritingMode};
export type WritingSelection={entryId:string;optionId:string};
export type WritingReviewEvidence={threadId:string;turnId:string;state:string;children:{threadId:string;state:string}[]};
export const writingModes:Record<WritingMode,{label:string;skill:string;hint:string}>={
 discuss:{label:'共同构思',skill:'writing-coach',hint:'从一个主题开始，一起找到想读下去的方向。'},
 draft:{label:'写下一章',skill:'serial-fiction',hint:'按已确定的方向写本次章节，也可以直接说明要写的范围。'},
 revise:{label:'局部修订',skill:'serial-fiction',hint:'针对所选正文或审稿问题准备修改提案。'},
 review:{label:'独立趣味审稿',skill:'engagement-review',hint:'由独立审稿 Agent 阅读固定稿件，给出证据和改进建议。'},
};
export const independentReviewMessage='请通过 dreamer_delegate 委派独立审稿子任务，skill=engagement-review，allowed=[]，继承本轮固定的章节或候选提案版本。请完整阅读目标，重点评估人物趣味、核心期待、成长或情绪兑现、有效反差、章尾承接与读者为什么继续读，引用具体文字给出最影响阅读的少量问题。回收子任务结果，区分通过、需修改和信息不足；不改写正文、不自动采用提案、不生成媒体。';

export function writingModeForSkill(skill:string,preferred:WritingMode='draft'):WritingMode|undefined{
 if(skill==='writing-coach')return 'discuss';
 if(skill==='engagement-review')return 'review';
 if(skill==='serial-fiction')return preferred==='revise'?'revise':'draft';
 return undefined;
}

export function writingSendState(mode:WritingMode|undefined,thread:any,pending:boolean){
 const waiting=!!mode&&!!thread?.turns.some((turn:any)=>['running','queued'].includes(turn.state));
 return {disabled:waiting&&!pending,label:pending?'核对上次发送':waiting?'等待本轮完成':thread?.state==='running'?'加入队列':'发送'};
}

export function writingDirectionPreview(summary:string){const characters=Array.from(summary);return characters.length>140?characters.slice(0,140).join('')+'…':summary;}
export function writingQuestionHeading(question:string){const end=question.search(/[?？]/);if(end>=0)return question.slice(0,end+1);const characters=Array.from(question);return characters.length>80?characters.slice(0,80).join('')+'…':question;}

/** Reading references do not authorize revision of those objects. */
export function explicitWritingTargets(thread:any):Ref[]{
 return (thread?.turns.at(-1)?.writing?.targetRefs??[]).filter((ref:Ref)=>['chapter','scene','knowledge','resource'].includes(ref.kind));
}

/** A completed review can belong to a draft or revision turn, not only review mode. */
export function writingReviewFollowup(threadId:string|undefined,thread:any,evidence:WritingReviewEvidence|null,changes:any[]){
 const turn=thread?.turns.at(-1);
 const matching=evidence?.threadId===threadId&&evidence?.turnId===turn?.id;
 const completed=!!matching&&evidence?.state==='completed'&&evidence.children.length>0&&evidence.children.every(child=>child.state==='completed');
 const reviewThreadIds=completed?evidence!.children.map(child=>child.threadId):[];
 const refs=[...(thread?.entries??[]).filter((entry:any)=>entry.turnId===turn?.id&&entry.role==='tool').flatMap((entry:any)=>entry.refs),...(turn?.bindings??[]).map((binding:any)=>binding.ref)];
 const proposalIds=[...new Set<string>(refs.filter((ref:any)=>ref.kind==='change').map((ref:any)=>ref.id))];
 const allProposalsApplied=proposalIds.length>0&&proposalIds.every(id=>changes.find(change=>change.id===id)?.data.state==='applied');
 return {completed,reviewThreadIds,allProposalsApplied};
}

/** A direction belongs to the final offer in the latest completed turn only. */
export function isCurrentWritingOffer(thread:any,entry:any):boolean{
 if(!thread||thread.state!=='idle'||!entry.writingOffer)return false;
 const turn=thread.turns.at(-1);
 if(!turn||turn.state!=='completed'||turn.id!==entry.turnId)return false;
 return thread.entries.filter((e:any)=>e.turnId===turn.id&&e.writingOffer).at(-1)?.id===entry.id;
}

/** Only the most recent produced manuscript, otherwise the explicit current scope. */
export function recentWritingTargets(thread:any):Ref[]{
 if(!thread)return [];
 const current=thread.turns.at(-1);
 const boundRefs=(current?.bindings?.map((b:any)=>b.ref)??[]) as Ref[];
 const latestScope=(current?.writing?[...current.writing.targetRefs,...boundRefs.filter(ref=>ref.kind==='change')]:boundRefs).filter((r:any)=>['chapter','change'].includes(r.kind));
 for(const turn of [...thread.turns].reverse()){
  if(turn.state!=='completed')continue;
  const refs=thread.entries.filter((e:any)=>e.turnId===turn.id&&e.role==='tool').flatMap((e:any)=>e.refs).filter((r:any)=>['chapter','change'].includes(r.kind));
  if(refs.length)return uniqueRefs(refs.some((ref:any)=>ref.kind==='chapter')?refs:[...latestScope,...refs]);
  if(turn===current&&latestScope.length)return uniqueRefs(latestScope);
 }
 return uniqueRefs(latestScope);
}
function uniqueRefs(refs:Ref[]):Ref[]{return [...new Map(refs.map(ref=>[`${ref.kind}:${ref.id}`,ref])).values()].slice(0,40);}
