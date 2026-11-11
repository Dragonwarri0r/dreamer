import type {RecordState} from '../../contracts/foundation.ts';
import {ensure} from '../../contracts/foundation.ts';
import type {ChapterData} from '../../contracts/longform.ts';

export type NovelChapter=RecordState<ChapterData>;
// Count Unicode characters, including punctuation, excluding whitespace.
export function manuscriptCharacters(body:string){let count=0;for(const char of body)if(!/\s/u.test(char))count++;return count;}
export function formatNovel(title:string,chapters:NovelChapter[],maxCharacters=0){
  ensure(Number.isSafeInteger(maxCharacters)&&maxCharacters>=0,'VALIDATION','分文件字数无效');
  const ordered=[...chapters].sort((a,b)=>a.data.number-b.data.number||a.id.localeCompare(b.id));
  const present=ordered.filter(c=>c.data.body.trim());
  ensure(present.length,'VALIDATION','工程还没有已保存的章节正文');
  const groups:{chapters:NovelChapter[];characters:number}[]=[];
  for(const chapter of present){
    const count=manuscriptCharacters(chapter.data.body),last=groups.at(-1);
    if(!last||(maxCharacters>0&&last.characters+count>maxCharacters))groups.push({chapters:[chapter],characters:count});
    else{last.chapters.push(chapter);last.characters+=count;}
  }
  const parts=groups.map(group=>{
    const lines=[title,''];let volume:string|undefined;
    for(const {data:c} of group.chapters){
      if(c.volume!==volume){volume=c.volume;if(volume)lines.push(volume,'');}
      lines.push(`第${c.number}章 ${c.title}`,'',c.body,'');
    }
    return {...group,text:lines.join('\n')+'\n',oversized:maxCharacters>0&&group.characters>maxCharacters};
  });
  return {parts,chapterCount:present.length,skippedEmptyCount:ordered.length-present.length,totalCharacters:parts.reduce((n,p)=>n+p.characters,0)};
}
