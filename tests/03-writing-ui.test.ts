import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {explicitWritingTargets,isCurrentWritingOffer,recentWritingTargets,writingModeForSkill,writingReviewFollowup,writingSendState} from '../apps/studio/src/writing-flow.ts';
import {prepareWritingSubmission,submitWriting,writingRequest} from '../apps/studio/src/writing-submission.ts';
import {WritingStartPayload,WritingContinuePayload} from '../packages/contracts/writing.ts';

const chapter=(seq=1)=>({kind:'chapter' as const,id:'a0fef61a-d43d-4cf3-9cac-de3a6784e332',seq});
test('03 a revision turn with completed independent review and adopted proposals advances without another review request',()=>{
 const threadId=randomUUID(),turnId=randomUUID(),childId=randomUUID(),proposalIds=[randomUUID(),randomUUID(),randomUUID()];
 const thread={turns:[{id:turnId,state:'completed',writing:{mode:'revise',targetRefs:[chapter()]},bindings:[]}],entries:[{turnId,role:'tool',refs:proposalIds.map(id=>({kind:'change',id,seq:1}))}]};
 const evidence={threadId,turnId,state:'completed',children:[{threadId:childId,state:'completed'}]};
 const changes=proposalIds.map(id=>({id,data:{state:'applied'}}));
 assert.deepEqual(writingReviewFollowup(threadId,thread,evidence,changes),{completed:true,reviewThreadIds:[childId],allProposalsApplied:true});
 assert.equal(writingReviewFollowup(threadId,thread,evidence,changes.slice(1)).allProposalsApplied,false,'missing proposal evidence is not adoption');
 assert.equal(writingReviewFollowup(threadId,thread,evidence,[...changes.slice(1),{id:proposalIds[0],data:{state:'partial'}}]).allProposalsApplied,false);
 for(const status of [{...evidence,turnId:randomUUID()},{...evidence,threadId:randomUUID()},{...evidence,state:'failed'},{...evidence,children:[]},{...evidence,children:[{threadId:childId,state:'failed'}]}]){
  const result=writingReviewFollowup(threadId,thread,status,changes);assert.equal(result.completed,false);assert.deepEqual(result.reviewThreadIds,[]);
 }
 assert.equal(writingReviewFollowup(threadId,thread,null,changes).completed,false,'a completed parent turn does not substitute for independent review');
});
test('03 discussing referenced chapters alone does not expose a revision action or infer its target scope',()=>{
 const target=chapter(),reference={...chapter(),id:randomUUID()};
 const thread={turns:[{state:'completed',writing:{mode:'discuss',targetRefs:[]},bindings:[{ref:reference}]}]};
 assert.deepEqual(explicitWritingTargets(thread),[]);
 assert.deepEqual(explicitWritingTargets({turns:[{...thread.turns[0],writing:{mode:'discuss',targetRefs:[target]}}]}),[target]);
 assert.deepEqual(explicitWritingTargets({turns:[{bindings:[{ref:reference}]}]}),[]);
});
test('03 writing waits for active turns without hiding input or blocking receipt recovery, while generic Agent can queue',()=>{
 for(const state of ['running','queued']){
  const thread={state,turns:[{state}]};
  assert.deepEqual(writingSendState('discuss',thread,false),{disabled:true,label:'等待本轮完成'});
  assert.deepEqual(writingSendState('draft',thread,true),{disabled:false,label:'核对上次发送'});
 }
 assert.deepEqual(writingSendState(undefined,{state:'running',turns:[{state:'running'}]},false),{disabled:false,label:'加入队列'});
 assert.deepEqual(writingSendState('review',{state:'idle',turns:[{state:'completed'}]},false),{disabled:false,label:'发送'});
});
test('03 writing direction buttons expire after a later offer or any new turn and never enable during execution',()=>{
 const offer={id:'offer-1',turnId:'turn-1',writingOffer:{question:'方向',options:[]}};
 const thread={state:'idle',turns:[{id:'turn-1',state:'completed'}],entries:[offer]};
 assert.equal(isCurrentWritingOffer(thread,offer),true);
 for(const state of ['running','queued','failed','unknown','interrupted'])assert.equal(isCurrentWritingOffer({...thread,state},offer),false);
 assert.equal(isCurrentWritingOffer({...thread,entries:[offer,{...offer,id:'offer-2'}]},offer),false);
 for(const state of ['completed','running','queued','failed','unknown','interrupted'])assert.equal(isCurrentWritingOffer({...thread,turns:[...thread.turns,{id:'turn-2',state}]},offer),false);
});

test('03 review and revision follow only the latest fixed manuscript and preserve candidate proposals',()=>{
 const old={...chapter(),id:randomUUID()},written=chapter(3),proposal={kind:'change' as const,id:randomUUID(),seq:1};
 const turn={id:'draft',state:'completed',writing:{mode:'draft',targetRefs:[old]},bindings:[{ref:old}]};
 const thread={turns:[turn],entries:[{turnId:'draft',role:'tool',refs:[written]}]};
 assert.deepEqual(recentWritingTargets(thread),[written]);
 const reviewed={...thread,turns:[turn,{id:'review',state:'completed',writing:{mode:'review',targetRefs:[written]},bindings:[{ref:written},{ref:proposal},{ref:old,purpose:'相邻前文，只作参考'}]}]};
 assert.deepEqual(recentWritingTargets(reviewed),[written,proposal]);
 const revised={turns:[{id:'revise',state:'completed',writing:{mode:'revise',targetRefs:[written]},bindings:[]}],entries:[{turnId:'revise',role:'tool',refs:[proposal]}]};
 assert.deepEqual(recentWritingTargets(revised),[written,proposal]);
 const selected={...reviewed,turns:[...reviewed.turns,{id:'discuss',state:'completed',writing:{mode:'discuss',targetRefs:[old]},bindings:[]}]};
 assert.deepEqual(recentWritingTargets(selected),[old],'an explicitly selected chapter replaces previous output scope');
});

test('03 writing start recovers a lost accepted response with the same receipt and never creates a second turn',async()=>{
 const submission=prepareWritingSubmission({title:'主题共创',goal:'长篇',text:'从仙侠成长主题开始讨论',mode:'discuss',bindings:[],targetRefs:[],owner:randomUUID()});
 const projectId=randomUUID(),threadId=randomUUID(),calls:{path:string;body:any}[]=[];let committed=false,starts=0,refreshes=0;
 const ctx={projectId,refresh:async()=>{refreshes++;}};
 const transport=async<T>(path:string,init?:RequestInit):Promise<T>=>{
  const body=JSON.parse(init!.body as string);calls.push({path,body});
  if(path.endsWith('/receipt'))return {found:committed,...(committed?{receipt:{result:{threadId}}}:{})} as T;
  starts++;committed=true;throw new Error('response lost');
 };
 await assert.rejects(submitWriting(ctx,submission,transport),/response lost/);
 const restored=JSON.parse(JSON.stringify(submission));
 assert.deepEqual(await submitWriting(ctx,restored,transport),{id:threadId,title:'主题共创'});
 assert.equal(starts,1);assert.equal(refreshes,1);
 assert.deepEqual(calls[0].body,calls[2].body);assert.equal(calls[1].body.requestId,submission.requestId);
 assert.equal(submission.threadId,undefined,'recovery must not transform the original start command into continue');
 WritingStartPayload.parse(calls[0].body.payload);
});

test('03 writing continuation keeps fixed selection and target versions; receipt failure never resends',async()=>{
 const target=chapter(2),selection={entryId:randomUUID(),optionId:'unexpected-partner'};
 const binding={ref:target,purpose:'选定段落',selection:{field:'body',from:3,to:5,text:'原文'}};
 const submission=prepareWritingSubmission({threadId:randomUUID(),title:'继续',goal:'',text:'选择此方向',mode:'discuss',bindings:[binding],targetRefs:[target],selection,owner:randomUUID()});
 const command=writingRequest(randomUUID(),submission);WritingContinuePayload.parse(command.payload);
 assert.deepEqual(command.payload.bindings,[binding]);assert.deepEqual(command.payload.targetRefs,[target]);assert.deepEqual(command.payload.selection,selection);
 let calls=0;
 await assert.rejects(submitWriting({projectId:command.projectId,refresh:async()=>{}},submission,async()=>{calls++;throw new Error('receipt forbidden');}),/receipt forbidden/);
 assert.equal(calls,1,'unknown receipt must be reconciled before another submission');
 assert.equal(writingModeForSkill('serial-fiction','revise'),'revise');
 assert.equal(writingModeForSkill('writing-coach'),'discuss');
 assert.equal(writingModeForSkill('engagement-review'),'review');
 assert.equal(writingModeForSkill('storyboard'),undefined,'existing media workflows keep their established route');
});
