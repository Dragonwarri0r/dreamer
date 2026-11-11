import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readInputDraft,writeInputDraft,clearInputDraft,inputDraftKey,clearConfirmedInputDraft} from '../apps/studio/src/experience/input-draft.ts';

test('11 unsubmitted text drafts isolate project, UID, run and attempt and clear only the accepted draft',()=>{
 const values=new Map<string,string>(),previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
 try{
  const a={projectId:'project:1',uid:'reader:one',runId:'run1',attemptId:'attempt1'},b={...a,uid:'reader:two'};
  assert.equal(writeInputDraft(a,'我想先问清楚缘由。'),true);assert.equal(writeInputDraft(b,'另一位观众的回答'),true);
  assert.equal(readInputDraft(a),'我想先问清楚缘由。');assert.equal(readInputDraft({...a,runId:'run2'}),'');assert.equal(readInputDraft({...a,attemptId:'attempt2'}),'');assert.equal(readInputDraft({...a,projectId:'project:2'}),'');
  assert.notEqual(inputDraftKey({...a,projectId:'a:b',uid:'c'}),inputDraftKey({...a,projectId:'a',uid:'b:c'}));
  clearInputDraft(a);assert.equal(readInputDraft(a),'');assert.equal(readInputDraft(b),'另一位观众的回答');assert.equal(values.has(inputDraftKey(a)),false);
  clearInputDraft(b);
 }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});

test('11 unavailable browser storage reports failure and preserves same-page draft without throwing',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw new Error('storage unavailable');}});
 const scope={projectId:'storage-failure',uid:'reader',runId:'run',attemptId:'attempt'};
 try{assert.equal(writeInputDraft(scope,'保留未提交的回答'),false);assert.equal(readInputDraft(scope),'保留未提交的回答');clearInputDraft(scope);assert.equal(readInputDraft(scope),'');}
 finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});

test('11 a failed draft write takes precedence over an older value still readable in storage',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map<string,string>();let fail=false;
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{if(fail)throw new Error('quota');values.set(key,value);},removeItem:(key:string)=>{if(fail)throw new Error('quota');values.delete(key);}}});
 const scope={projectId:'quota',uid:'reader',runId:'run',attemptId:'attempt'};
 try{assert.equal(writeInputDraft(scope,'旧回答'),true);fail=true;assert.equal(writeInputDraft(scope,'刚输入的新回答'),false);assert.equal(readInputDraft(scope),'刚输入的新回答');clearInputDraft(scope);assert.equal(readInputDraft(scope),'');fail=false;assert.equal(writeInputDraft(scope,'恢复持久保存'),true);assert.equal(readInputDraft(scope),'恢复持久保存');clearInputDraft(scope);}
 finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});

test('11 confirmed commands clear the original attempt after navigation, skip, or receipt recovery',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),values=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)}});
 const original={projectId:'confirm',uid:'first',runId:'old-run',attemptId:'old-attempt'},next={...original,attemptId:'new-attempt'},other={...original,uid:'second'};
 try{writeInputDraft(next,'下一次回答');writeInputDraft(other,'另一档案');for(const operation of ['activity.skip','activity.submit','activity.confirmIntent','activity.reconcile']){writeInputDraft(original,'原回答');clearConfirmedInputDraft(original.projectId,original.uid,{operation,runId:original.runId,payload:{attemptId:original.attemptId}});assert.equal(readInputDraft(original),'');assert.equal(readInputDraft(next),'下一次回答');assert.equal(readInputDraft(other),'另一档案');}clearInputDraft(next);clearInputDraft(other);}
 finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});
