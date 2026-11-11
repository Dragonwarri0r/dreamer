import {useSyncExternalStore} from 'react';
type ManagedEnums=Record<string,string>;
const cache=new Map<string,{raw:string|null;value:ManagedEnums}>(),memory=new Map<string,ManagedEnums>(),changed='dreamer:managed-enums-changed';
/** Editor metadata is shared by every window for this project/script, never part of a release. */
export function useManagedActivityEnums(projectId:string,scriptId:string){
 const key=`dreamer:managed-enums:${JSON.stringify([projectId,scriptId])}`;
 const read=()=>{let raw:string|null=null;try{raw=localStorage.getItem(key);}catch{return memory.get(key)??empty;}
  const previous=cache.get(key);if(previous?.raw===raw)return previous.value;
  let value:ManagedEnums=memory.get(key)??empty;try{const parsed=raw?JSON.parse(raw):null;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))value=Object.fromEntries(Object.entries(parsed).filter(([,v])=>typeof v==='string')) as ManagedEnums;}catch{}
  cache.set(key,{raw,value});return value;
 };
 const subscribe=(notify:()=>void)=>{const listener=(event:Event)=>{if(event instanceof StorageEvent&&event.key!==key)return;notify();};window.addEventListener('storage',listener);window.addEventListener(changed,listener);return()=>{window.removeEventListener('storage',listener);window.removeEventListener(changed,listener);};};
 const value=useSyncExternalStore(subscribe,read);
 const write=(next:ManagedEnums|((old:ManagedEnums)=>ManagedEnums))=>{const value=typeof next==='function'?next(read()):next;memory.set(key,value);try{localStorage.setItem(key,JSON.stringify(value));}catch{}cache.delete(key);window.dispatchEvent(new Event(changed));};
 return [value,write] as const;
}
const empty:ManagedEnums={};
