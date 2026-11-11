import { RuntimeGeneration, type RuntimeTextGenerator } from '../../packages/core/experience/generation.ts';
import { RuntimeMedia } from '../../packages/core/experience/media.ts';
import { RuntimeAdoption } from '../../packages/core/experience/adoption.ts';
import { ExperienceArchives } from '../../packages/core/experience/archive.ts';
import { ExperienceExporter } from '../../packages/infra/experience-export.ts';
import { NovelExporter } from '../../packages/infra/novel-export.ts';
import { InstanceCueBinding, InstanceFallback } from '../../packages/contracts/experience.ts';
import type { ExperienceRun, SegmentInstance } from '../../packages/contracts/experience.ts';
import type { RunScope } from '../../packages/core/experience/ports.ts';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Scripts, mediaPlanId } from '../../packages/core/story/script.ts';
import { ExperienceRuntime } from '../../packages/core/experience/runtime.ts';
import {CloudVideoSettings} from '../../packages/infra/cloud-video-settings.ts';
import {CloudVideoProvider} from '../../packages/infra/cloud-video.ts';
import { SqliteStore } from '../../packages/infra/sqlite.ts';
import { CommandBus, Projects } from '../../packages/core/foundation/commands.ts';
import { Id, parse } from '../../packages/contracts/foundation.ts';
import { Agents } from '../../packages/core/agent/agent.ts';
import { AppServerSession } from '../../packages/infra/agent/app-server.ts';
import type { AgentFactory } from '../../packages/core/agent/port.ts';
import type { Ref } from '../../packages/contracts/foundation.ts';
import { Story,Resources,Knowledge } from '../../packages/core/modules/authoring.ts';
import type { Repository } from '../../packages/core/foundation/ports.ts';
import { ensure } from '../../packages/contracts/foundation.ts';
import { Storyboard } from '../../packages/core/modules/storyboard.ts';
import { Production } from '../../packages/core/modules/production.ts';
import { MediaFiles } from '../../packages/infra/media.ts';
import { LocalProvider,LtxProvider,H3Provider,CodexImageProvider } from '../../packages/infra/providers.ts';
import type { MediaProvider } from '../../packages/contracts/production.ts';
import { join } from 'node:path';
import { AssembleProvider } from '../../packages/infra/assembler.ts';
import { Editorial } from '../../packages/core/modules/editorial.ts';
import { Review } from '../../packages/core/modules/review.ts';
import {Chapters,Episodes} from '../../packages/core/modules/longform.ts';
import {intentHash} from '../../packages/core/modules/storyboard.ts';
import type { DraftDomain } from '../../packages/core/modules/authoring.ts';

export class Application {
  readonly store: SqliteStore;
  readonly bus: CommandBus;
  readonly projects: Projects;
  readonly views = new Map<string, (projectId: string) => unknown>();
  readonly closers: (() => void)[] = [];
  readonly readers=new Map<string,(pid:string,ref?:Ref)=>unknown>();
  readonly agents:Agents;
  readonly chapters:Chapters;readonly episodes:Episodes;
  readonly story:Story;readonly resources:Resources;readonly knowledge:Knowledge;
  readonly repositories=new Map<string,Repository<any>>();
  readonly storyboard:Storyboard;
  readonly production:Production;
  readonly videoSettings:CloudVideoSettings;
  readonly cloudVideo:CloudVideoProvider[];
  readonly editorial:Editorial;
  readonly review:Review;
  readonly scripts:Scripts;
  readonly experienceRuntime:ExperienceRuntime;
  readonly runtimeGeneration:RuntimeGeneration;
  readonly runtimeMedia:RuntimeMedia;
  readonly experienceArchives:ExperienceArchives;
  readonly experienceExporter:ExperienceExporter;
  readonly novelExporter:NovelExporter;
  readonly offline:boolean;
  constructor(readonly root: string,options:{agentFactory?:AgentFactory;providers?:MediaProvider[];recover?:boolean;runtimeGenerator?:RuntimeTextGenerator;offline?:boolean}={}) {
    this.offline=options.offline===true;
    if(this.offline)options={...options,providers:[],runtimeGenerator:undefined,recover:false,agentFactory:()=>{throw new Error('离线 Demo 不调用 Agent；使用 npm start 并自行配置后可启用');}};
    this.videoSettings=new CloudVideoSettings(root);this.cloudVideo=this.offline?[]:(['seedance','wan','fal-h3'] as const).map(id=>new CloudVideoProvider(id,this.videoSettings,root));
    this.store = new SqliteStore(root); this.bus = new CommandBus(this.store); this.projects = new Projects(this.store, this.bus);
    this.repositories.set('project',this.projects.repo);
    const read=(ref:Ref,pid:string)=>{const repo=this.repositories.get(ref.kind);ensure(repo,'NOT_FOUND','领域未接入');const row=repo.at(ref,pid);this.assertPublic(ref.kind,row);return row;};
    this.chapters=new Chapters(this.store,this.bus,read);this.register('chapters',this.chapters.repo);
    this.novelExporter=new NovelExporter(root,pid=>this.store.transaction(()=>({title:this.projects.repo.get(pid,pid).data.title,chapters:this.chapters.repo.list(pid)})));
    this.story=new Story(this.store,this.bus,read);this.resources=new Resources(this.store,this.bus,read);this.knowledge=new Knowledge(this.store,this.bus,read);
    this.register('scenes',this.story.repo);this.register('resources',this.resources.repo);this.register('knowledge',this.knowledge.repo);
    this.views.set('resources',pid=>this.resources.repo.list(pid).map(r=>{const published=this.resources.repo.history(r.id,pid).find(h=>h.data.status==='published');return {...r,publishedRef:published?{kind:'resource',id:r.id,seq:published.seq}:null};}));
    this.storyboard=new Storyboard(this.store,this.bus,read);this.register('shots',this.storyboard.repo);this.views.set('shots',pid=>this.storyboard.view(pid));
    this.episodes=new Episodes(this.store,this.bus,read,pid=>this.store.discovery.catalog(pid,'chapter'),pid=>this.store.discovery.catalog(pid,'scene'),pid=>this.store.discovery.catalog(pid,'shot'));this.register('episodes',this.episodes.repo);
    this.production=new Production(this.store,this.bus,new MediaFiles(root),options.providers??[new LocalProvider(join(root,'runtime'),'placeholder'),new LocalProvider(join(root,'runtime'),'tts'),new LtxProvider(),new H3Provider(),new CodexImageProvider(join(root,'runtime','images')),...this.cloudVideo],read,this.store.experience);
    this.register('jobs',this.production.jobs);this.register('artifacts',this.production.artifacts);this.views.set('capabilities',()=>this.production.capabilities());
    if(!this.production.providers.has('ffmpeg'))this.production.providers.set('ffmpeg',new AssembleProvider(join(root,'runtime'),new MediaFiles(root)));
    this.editorial=new Editorial(this.store,this.bus,read,this.production,this.storyboard,this.episodes,this.chapters);this.register('cuts',this.editorial.repo);this.register('builds',this.editorial.builds);
    this.scripts=new Scripts(this.store,this.bus,this.store.experience,read,()=>this.production.capabilities(),()=>({runtimeText:Boolean(options.runtimeGenerator),runtimeMedia:true,activityVersions:['choice@1',...(options.runtimeGenerator?['text-intent@1']:[])]}),(ref,pid)=>existsSync(this.production.files.path(this.production.artifacts.at(ref,pid).data.sha256)),()=>options.runtimeGenerator?.configuration().fingerprint,(ref,pid)=>this.repositories.get(ref.kind)!.get(ref.id,pid));this.register('scripts',this.scripts.repo);
    const runtimeRead=(ref:Ref,pid:string)=>{const repo=this.repositories.get(ref.kind);ensure(repo,'NOT_FOUND','领域未接入');return repo.at(ref,pid);};
    this.experienceRuntime=new ExperienceRuntime(this.store.experience,runtimeRead);
    this.experienceArchives=new ExperienceArchives(this.store.experience,this.experienceRuntime);
    this.experienceExporter=new ExperienceExporter(this.experienceArchives,root);
    this.closers.push(()=>this.experienceExporter.close());
    const prepareMedia=(scope:RunScope,instance:SegmentInstance)=>this.runtimeMedia.prepare(scope,instance);
    this.runtimeMedia=new RuntimeMedia(this.store.experience,this.production,pid=>this.projects.repo.get(pid,pid).data.generationLimit,{accept:(scope,instance)=>{this.experienceRuntime.acceptPreparedInternal(scope,instance);},fixed:(scope,instance,media)=>this.experienceRuntime.compileFixedInternal(scope,instance,media)},read);
    this.runtimeGeneration=new RuntimeGeneration(this.store.experience,runtimeRead,options.runtimeGenerator,{acceptPreparedInternal:(scope,instance)=>{this.experienceRuntime.acceptPreparedInternal(scope,prepareMedia(scope,instance));},acceptActivityInternal:(scope,attempt)=>{this.experienceRuntime.acceptActivityInternal(scope,attempt);}});
    this.experienceRuntime.hooks.prepare=context=>prepareMedia(context.scope,this.runtimeGeneration.prepare(context));
    this.experienceRuntime.hooks.activity=context=>this.runtimeGeneration.activity(context);
    this.experienceRuntime.hooks.activityRecovery=context=>this.runtimeGeneration.activityRecovery(context);
    this.experienceRuntime.hooks.reconcileActivity=context=>this.runtimeGeneration.activityReconcile(context);
    this.experienceRuntime.hooks.instanceCommand=context=>{const mediaJobs=this.production.jobs.list(context.scope.projectId).some(j=>j.data.owner.type==='experience'&&j.data.owner.instanceId===context.instance.id);return mediaJobs||context.failedStage==='producing'?this.runtimeMedia.command(context.scope,context.instance,context.operation,context.failedStage):this.runtimeGeneration.instanceCommand(context);};
    this.production.experienceScope=(pid,runId)=>{const row=this.store.experience.lookupRun<ExperienceRun>(pid,runId);return {projectId:pid,uid:row.data.uid,runId};};
    this.production.onExperienceResult=job=>this.runtimeMedia.complete(job);this.production.onExperienceState=job=>this.runtimeMedia.state(job);
    this.bus.register('instance.review',z.strictObject({uid:z.string().min(1).max(80),runId:Id,instanceId:Id,resultRevision:z.number().int().positive(),approve:z.boolean()}),(p,pid)=>{const instance=this.runtimeGeneration.reviewInternal({projectId:pid,uid:p.uid,runId:p.runId},p.instanceId,p.resultRevision,p.approve);const actual=this.store.experience.get<SegmentInstance>('instances',instance.id,{projectId:pid,uid:p.uid,runId:p.runId}).data;return {instanceId:actual.id,status:actual.status,resultRevision:actual.resultRevision};},true,()=>({scope:'experience'}));
    this.bus.register('instance.bindCue',InstanceCueBinding,(p,pid)=>this.runtimeMedia.bindCue({projectId:pid,uid:p.uid,runId:p.runId},p),true,()=>({scope:'experience'}));
    this.bus.register('instance.fallback',InstanceFallback,(p,pid)=>this.runtimeMedia.useFallback({projectId:pid,uid:p.uid,runId:p.runId},p),true,()=>({scope:'experience'}));
    this.closers.push(()=>this.runtimeGeneration.close());
    this.bus.register('simulation.start',z.strictObject({id:Id,expectedSeq:z.number().int().positive(),uid:z.string().min(1).max(80)}),(p,pid)=>{const release=this.scripts.publish(pid,{id:p.id,expectedSeq:p.expectedSeq,kind:'simulation',confirmGeneration:false});const result=this.experienceRuntime.startInternal({projectId:pid,uid:p.uid},{protocolVersion:1,requestId:randomUUID(),projectId:pid,releaseId:release.id,mode:'simulation'});return {...result,releaseId:release.id};},true,()=>({scope:'experience'}));
    this.production.onResult=(job,artifact)=>{const target=job.data.intent.target;if(target?.kind==='build')this.editorial.complete(job,artifact);else if(target?.kind==='shot'){
      // A shot's narration is a separate audio asset, not a visual Take.
      const media=this.production.artifacts.at(artifact,job.projectId);
      if(!media.data.mediaType.startsWith('audio/'))this.storyboard.attach(target.id,job.projectId,target,artifact,job.data.intent.provider,job.data.intent.quality,job.id);
    }else if(target?.kind==='resource'){const current=this.resources.repo.get(target.id,job.projectId);this.resources.update(current.id,job.projectId,current.seq,{...current.data,status:current.data.status==='published'?'draft':current.data.status,references:[...current.data.references,{artifact,purpose:current.data.type==='voice'?'voice':'appearance',source:`Job ${job.id} · 输入 v${target.seq}`,selected:false}]},{source:'system'});}};
    this.readers.set('project',(pid,ref)=>{if(ref)return this.projects.repo.at(ref,pid);const p=this.projects.repo.get(pid,pid);this.projects.repo.checkpoint(pid,pid,p.seq);return [p];});
    this.agents=new Agents(this.store,this.bus,options.agentFactory??(()=>new AppServerSession(root)),this.readers,this.store.discovery,(pid,kind,id,seq)=>{const repo=this.repositories.get(kind);ensure(repo,'NOT_FOUND','领域不存在');return repo.checkpoint(id,pid,seq);},()=>this.production.capabilities(),{read:(pid,ref,offset,limit)=>this.scripts.readPage(pid,ref,offset,limit),validate:(pid,ref)=>this.scripts.diagnostics(this.scripts.repo.at(ref,pid).data,pid),impact:(pid,id)=>this.scripts.impact(pid,id)});
    this.register('threads',this.agents.threads);this.register('works',this.agents.works);
    this.review=new Review(this.store,this.bus,new Map<string,DraftDomain<any>>([['chapter',this.chapters],['episode',this.episodes],['scene',this.story],['resource',this.resources],['knowledge',this.knowledge],['shot',this.storyboard],['cut',this.editorial],['script',this.scripts]]),read,this.agents);this.register('changes',this.review.changes);this.register('notes',this.review.notes);this.views.set('changes',pid=>this.review.view(pid));
    new RuntimeAdoption(this.store,this.store.experience,this.bus,this.review,{scene:this.story,chapter:this.chapters});
    if(options.recover!==false)this.agents.recover(this.store.projects().map(p=>p.id));this.closers.push(()=>this.agents.close());
    if(options.recover!==false){const pids=this.store.projects().map(p=>p.id);this.production.recover(pids);const scopes=pids.flatMap(pid=>this.store.experience.runScopes(pid));this.runtimeGeneration.recover(scopes);this.experienceArchives.recover(scopes);}this.closers.push(()=>this.production.close());
  }
  register(view:string,repo:Repository<any>){this.repositories.set(repo.kind,repo);this.views.set(view,pid=>repo.list(pid).filter(row=>this.publicRow(repo.kind,row)));this.readers.set(repo.kind,(pid,ref)=>{if(ref){const row=repo.at(ref,pid);this.assertPublic(repo.kind,row);return row;}const rows=repo.list(pid).filter(row=>this.publicRow(repo.kind,row));for(const row of rows)repo.checkpoint(row.id,pid,row.seq);return rows;});}
  private publicRow(kind:string,row:any){return kind==='job'?row.data.owner?.type!=='experience':kind==='artifact'?row.data.metadata?.visibility!=='experience':true;}
  assertPublic(kind:string,row:any){ensure(this.publicRow(kind,row),'NOT_FOUND','对象不存在于作者工作区');}
  object(projectId:string,kind:string,id:string){
    const repo=this.repositories.get(kind);ensure(repo,'NOT_FOUND','领域不存在');const row=repo.get(id,projectId);this.assertPublic(kind,row);
    return kind==='shot'?{...row,freshness:Object.fromEntries(row.data.takes.map((t:any)=>[t.id,t.intentHash!==intentHash(row.data)]))}:row;
  }
  snapshot(projectId: string,compact=false) {
    parse(Id, projectId); const project=this.projects.repo.get(projectId,projectId);
    return { project, ...Object.fromEntries([...this.views].map(([name,read])=>[name,compact&&['chapters','episodes','scenes','shots','knowledge','threads','scripts'].includes(name)?this.store.discovery.catalog(projectId,({chapters:'chapter',episodes:'episode',scenes:'scene',shots:'shot',knowledge:'knowledge',threads:'thread',scripts:'script'} as any)[name]):read(projectId)])) };
  }
  scriptMedia(pid:string) {
    return this.editorial.builds.list(pid).flatMap(row=>{const b=row.data;if(!b.output)return [];try{const a=this.production.artifacts.at(b.output,pid).data;const media={buildRef:this.editorial.builds.checkpoint(row.id,pid,row.seq),fromFrame:0,toFrame:b.range.endFrame-b.range.startFrame,fps:b.snapshot.fps,contentHash:a.sha256};this.scripts.validateMedia(pid,media);return [{title:b.title,media,planId:mediaPlanId(media)}];}catch{return [];}});
  }
  close() { for(const close of this.closers) close(); this.store.close(); }
}
