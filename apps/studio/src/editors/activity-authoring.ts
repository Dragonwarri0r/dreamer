import {stable} from '../../../../packages/contracts/foundation.ts';
import type {FixedMedia,ScriptPlanData} from '../../../../packages/contracts/interactive-script.ts';
import type {ActivityDefinition} from '../../../../packages/contracts/activities.ts';

export function uniqueAuthorKey(existing:Iterable<string>,prefix:string){const used=new Set(existing);let i=1;while(used.has(`${prefix}${i}`))i++;return `${prefix}${i}`;}
export function newActivityOptionId(){return `option_${crypto.randomUUID().replaceAll('-','')}`;}
export function activityOptionIds(activity:ActivityDefinition):string[]{const a=activity as any;return a.version===1&&['choice','text-intent'].includes(a.type)?(a.config.options??a.config.intents??[]).map((o:any)=>o.id):[];}
export function mappedEnumKeys(plan:ScriptPlanData,activity:ActivityDefinition){const field=activity.type==='choice'?'optionId':'intentId';return [...new Set(activity.resultMapping.filter(e=>e.op==='set'&&e.value.source==='result'&&e.value.field===field).map(e=>e.key))].filter(key=>plan.variables.some(v=>v.key===key&&v.type==='enum'));}
export function enumHasOtherWriters(plan:ScriptPlanData,activity:ActivityDefinition,key:string){
 const ownNodes=new Set(plan.nodes.filter(n=>n.type==='activity'&&n.activityId===activity.id).map(n=>n.id));
 if(plan.variables.find(v=>v.key===key)?.allowedWriters.some(w=>!ownNodes.has(w.sourceId)))return true;
 return plan.nodes.some(n=>{if(ownNodes.has(n.id))return false;const effects=n.type==='activity'?plan.activities.find(a=>a.id===n.activityId)?.resultMapping??[]:n.type==='checkpoint'?n.commitEffects:n.type==='segment'?[...n.completionEffects,...('generationContract'in n.contentSpec?n.contentSpec.generationContract?.outcomes.flatMap(o=>o.completionEffects)??[]:[])]:[];return effects.some(e=>e.key===key);});
}
/** Extend only: old initial, branch, constant and skip references remain valid. */
export function extendActivityEnums(plan:ScriptPlanData,activity:ActivityDefinition,keys:string[]){
 const options=activityOptionIds(activity),mapped=new Set(mappedEnumKeys(plan,activity));
 return {...plan,variables:plan.variables.map(v=>{if(v.type!=='enum'||!keys.includes(v.key)||!mapped.has(v.key))return v;const values=[...new Set([...v.values,...options])];if(values.length>64)throw new Error(`变量「${v.label}」已超过 64 个枚举值，请在变量页确认并整理不再使用的值。`);return {...v,values};})};
}
export function replaceAuthorActivity(plan:ScriptPlanData,activity:ActivityDefinition,managedKey?:string){const next={...plan,activities:plan.activities.map(a=>a.id===activity.id?activity:a)};return managedKey&&!enumHasOtherWriters(next,activity,managedKey)?extendActivityEnums(next,activity,[managedKey]):next;}
export function diagnosticTarget(plan:ScriptPlanData,d:any):{view:string;nodeId?:string}{
 if(d.nodeId&&plan.nodes.some(n=>n.id===d.nodeId))return {view:'document',nodeId:d.nodeId};
 const path=String(d.fieldPath??'').split('.');
 if(path[0]==='variables')return {view:'variables'};
 if(path[0]==='nodes'){const n=plan.nodes[Number(path[1])]??plan.nodes.find(n=>n.id===path[1]);if(n)return {view:'document',nodeId:n.id};}
 if(path[0]==='activities'){const a=plan.activities[Number(path[1])]??plan.activities.find(a=>a.id===path[1]),n=plan.nodes.find(n=>n.type==='activity'&&n.activityId===a?.id);if(n)return {view:'document',nodeId:n.id};}
 if(path[0]==='cues'){const cue=plan.cues[Number(path[1])]??plan.cues.find(c=>c.id===path[1]);if(cue)return {view:'document',nodeId:cue.segmentNodeId};}
 return {view:'production'};
}

/** Same canonical identity as the Host; preview is pinned to the selected Build revision. */
export async function fixedCuePlanId(media:FixedMedia){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(media))),h=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
export function validFixedCueRange(appear:number,deadline:number,duration:number){return Number.isInteger(appear)&&Number.isInteger(deadline)&&appear>=0&&appear<deadline&&deadline<duration;}
