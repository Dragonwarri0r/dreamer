import {randomUUID} from 'node:crypto';
import type {Application} from '../../apps/host/application.ts';
import {ChapterData} from '../../packages/contracts/longform.ts';
import {SceneData} from '../../packages/contracts/creative.ts';
import {ShotData} from '../../packages/contracts/storyboard.ts';

/** Deterministic story-shaped load, in an isolated project; never user content. */
export function seedLongform(app:Application,pid:string,count=1200){
 const chapters:any[]=[],scenes:any[]=[],shots:any[]=[];
 app.store.transaction(()=>{
  for(let n=1;n<=count;n++){
   const chapter=app.chapters.repo.create(pid,ChapterData.parse({
    title:`吉皮梯修行 ${n}`,number:n,volume:`第 ${Math.ceil(n/100)} 卷`,status:n%3?'draft':'outline',
    synopsis:`吉皮梯在第 ${n} 次历练中与同伴解决问题。`,
    body:'吉皮梯翻阅上下文书卷，确认任务后再施展工具。'.repeat(300)+(n===1024?'青铜罗盘的秘密藏在旧书院。':'纸鹤仍在庭前飞翔。'),
   }));chapters.push(chapter);
   const scene=app.story.repo.create(pid,SceneData.parse({title:`${n} · 书院试炼`,order:n-1,chapterId:chapter.id,blocks:[{id:randomUUID(),type:'action',text:`第 ${n} 章，吉皮梯打开工具匣。`}]}));scenes.push(scene);
   const ref=app.story.checkpoint(scene.id,pid,scene.seq);
   for(let j=0;j<5;j++)shots.push(app.storyboard.repo.create(pid,ShotData.parse({title:`${n}-${j+1} · 吉皮梯镜头`,order:(n-1)*5+j,scene:ref,durationFrames:24*12,intent:'阅读、观察、行动与复核',action:n===1024?'青铜罗盘指向山门':'纸鹤飞过书院'})));
  }
 });return {chapters,scenes,shots};
}
