import {z} from 'zod';
import {Id} from '../contracts/foundation.ts';
import {InstanceCueBinding,InstanceFallback} from '../contracts/experience.ts';
import {InstanceProposal} from '../contracts/adoption.ts';
import {CommandBus,Projects} from './foundation/commands.ts';
import type {Persistence} from './foundation/ports.ts';
import {Story,Resources,Knowledge} from './modules/authoring.ts';
import {Chapters,Episodes} from './modules/longform.ts';
import {Storyboard} from './modules/storyboard.ts';
import {Production} from './modules/production.ts';
import {Editorial} from './modules/editorial.ts';
import {Agents} from './agent/agent.ts';
import {Review} from './modules/review.ts';
import {Scripts} from './story/script.ts';
import type {ExperiencePersistence} from './experience/ports.ts';
import type {Discovery} from '../contracts/longform.ts';

/** Registers schemas only. Every persistence or execution operation fails closed. */
export function schemaRegistry(){
 const unavailable=()=>{throw new Error('Schema export cannot read, write, recover, or execute');};
 const store=new Proxy({repository:(kind:string)=>new Proxy({kind},{get:(target,key)=>key==='kind'?target.kind:unavailable})},{get:(target,key)=>key==='repository'?target.repository:unavailable}) as unknown as Persistence;
 const experience=new Proxy({},{get:()=>unavailable}) as ExperiencePersistence,bus=new CommandBus(store);
 new Projects(store,bus);
 const chapters=new Chapters(store,bus,unavailable),story=new Story(store,bus,unavailable),resources=new Resources(store,bus,unavailable),knowledge=new Knowledge(store,bus,unavailable),board=new Storyboard(store,bus,unavailable);
 const episodes=new Episodes(store,bus,unavailable,unavailable,unavailable,unavailable);
 const production=new Production(store,bus,{path:unavailable,import:unavailable},[],unavailable,undefined,false);
 const editorial=new Editorial(store,bus,unavailable,production,board,episodes,chapters),scripts=new Scripts(store,bus,experience,unavailable,()=>[]);
 const agents=new Agents(store,bus,unavailable,new Map(),new Proxy({},{get:()=>unavailable}) as Discovery,unavailable);
 new Review(store,bus,new Map([['script',scripts]]),unavailable,agents);
 bus.register('simulation.start',z.strictObject({id:Id,expectedSeq:z.number().int().positive(),uid:z.string().min(1).max(80)}),unavailable,true);
 bus.register('instance.review',z.strictObject({uid:z.string().min(1).max(80),runId:Id,instanceId:Id,resultRevision:z.number().int().positive(),approve:z.boolean()}),unavailable,true);
 bus.register('instance.bindCue',InstanceCueBinding,unavailable,true);
 bus.register('instance.fallback',InstanceFallback,unavailable,true);
 bus.register('instance.propose',InstanceProposal,unavailable,true);
 return bus;
}
