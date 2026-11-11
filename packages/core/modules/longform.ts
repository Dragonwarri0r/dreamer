import {z} from 'zod';
import {ChapterData,EpisodeData} from '../../contracts/longform.ts';
import {Id,Expected,ensure,type RecordState} from '../../contracts/foundation.ts';
import type {Persistence} from '../foundation/ports.ts';
import {DraftDomain,type ReferenceReader} from './authoring.ts';
import type {CommandBus} from '../foundation/commands.ts';
import type {SceneData} from '../../contracts/creative.ts';
import type {ShotData} from '../../contracts/storyboard.ts';

export class Chapters extends DraftDomain<ChapterData>{
  constructor(store:Persistence,bus:CommandBus,read:ReferenceReader){
    super('chapter',ChapterData,store,bus,(d,pid)=>{if(d.branchOf)read(d.branchOf,pid);});
  }
}
export class Episodes extends DraftDomain<EpisodeData>{
  constructor(store:Persistence,bus:CommandBus,read:ReferenceReader,
    private chapterRows:(pid:string)=>RecordState<ChapterData>[],
    private sceneRows:(pid:string)=>RecordState<SceneData>[],
    private shotRows:(pid:string)=>RecordState<ShotData>[]){
    super('episode',EpisodeData,store,bus,(d,pid)=>{
      ensure(new Set(d.chapterIds).size===d.chapterIds.length&&new Set(d.shotIds).size===d.shotIds.length,'VALIDATION','制作单包含重复章节或镜头');
      ensure(Object.keys(d.shotFrames).every(id=>d.shotIds.includes(id)),'VALIDATION','时长设置包含制作单之外的镜头');
      const chapters=new Set(chapterRows(pid).map(c=>c.id)),scenes=new Map(sceneRows(pid).map(s=>[s.id,s])),shots=new Map(shotRows(pid).map(s=>[s.id,s]));
      for(const id of d.chapterIds)ensure(chapters.has(id),'NOT_FOUND','章节不属于当前工程');
      for(const id of d.shotIds){
        const shot=shots.get(id);ensure(shot&&!shot.data.archived,'VALIDATION','制作单镜头不存在或已归档');
        const chapterId=shot.data.scene?scenes.get(shot.data.scene.id)?.data.chapterId:undefined;
        ensure(!chapterId||d.chapterIds.includes(chapterId),'VALIDATION','镜头来源章节不在制作范围内');
      }
      if(d.branchOf)read(d.branchOf,pid);
    });
    bus.register('episode.fromChapters',z.strictObject({title:EpisodeData.shape.title,chapterIds:z.array(Id).min(1).max(100),targetSeconds:EpisodeData.shape.targetSeconds}),(p,pid,a)=>{
      const data=EpisodeData.parse({...p,shotIds:this.available(pid,p.chapterIds).map(s=>s.id)});
      // Use the same validation as edits, without manufacturing a second command.
      ensure(new Set(p.chapterIds).size===p.chapterIds.length,'VALIDATION','章节重复');
      const ids=new Set(chapterRows(pid).map(c=>c.id));
      ensure(p.chapterIds.every(id=>ids.has(id)),'NOT_FOUND','章节不属于当前工程');
      return this.repo.create(pid,data);
    },true);
    bus.register('episode.schedule',Expected.extend({shotIds:EpisodeData.shape.shotIds}),(p,pid,a)=>{
      const e=this.repo.get(p.id,pid);return this.update(p.id,pid,p.expectedSeq,{...e.data,shotIds:p.shotIds,shotFrames:Object.fromEntries(Object.entries(e.data.shotFrames).filter(([id])=>p.shotIds.includes(id)))},a);
    },true);
  }
  available(pid:string,chapterIds:string[]){
    const scenes=new Map(this.sceneRows(pid).map(s=>[s.id,s]));
    return this.shotRows(pid).filter(s=>!s.data.archived&&s.data.scene&&chapterIds.includes(scenes.get(s.data.scene.id)?.data.chapterId??''))
      .sort((a,b)=>{const x=scenes.get(a.data.scene!.id)!,y=scenes.get(b.data.scene!.id)!;return chapterIds.indexOf(x.data.chapterId!)-chapterIds.indexOf(y.data.chapterId!)||x.data.order-y.data.order||a.data.order-b.data.order||a.id.localeCompare(b.id);});
  }
}
