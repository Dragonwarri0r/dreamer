import {mkdirSync,mkdtempSync,existsSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {Id,ensure,parse} from '../contracts/foundation.ts';
import {NovelExportRequest,NovelExportResult} from '../contracts/novel-export.ts';
import {formatNovel,type NovelChapter} from '../core/story/novel-export.ts';

function safeStem(title:string){return Array.from(title.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_')).slice(0,48).join('').replace(/[.\s]+$/g,'')||'小说';}
export class NovelExporter {
  constructor(private root:string,private snapshot:(projectId:string)=>{title:string;chapters:NovelChapter[]}){}
  private directory(projectId:string,id:string){return resolve(this.root,'exports','novels',parse(Id,projectId),parse(Id,id));}
  export(input:unknown):NovelExportResult{
    const request=parse(NovelExportRequest,input),{projectId,requestId,maxCharacters}=request;
    const directory=this.directory(projectId,requestId),receipt=join(directory,'manifest.json');
    if(existsSync(receipt)){
      const saved=parse(NovelExportResult,JSON.parse(readFileSync(receipt,'utf8')));
      ensure(saved.maxCharacters===maxCharacters,'IDEMPOTENCY_CONFLICT','同一导出请求不能更改分文件字数');
      return saved;
    }
    const snapshot=this.snapshot(projectId),formatted=formatNovel(snapshot.title,snapshot.chapters,maxCharacters);
    const parent=resolve(directory,'..');mkdirSync(parent,{recursive:true,mode:0o700});
    const staging=mkdtempSync(join(parent,'.export-'));
    try{
      const files=formatted.parts.map((part,index)=>{
        const firstNumber=part.chapters[0].data.number,lastNumber=part.chapters.at(-1)!.data.number;
        const suffix=formatted.parts.length===1?'全文':`${String(index+1).padStart(3,'0')}-第${firstNumber}-${lastNumber}章`;
        const name=`${safeStem(snapshot.title)}-${suffix}.txt`;
        writeFileSync(join(staging,name),part.text,{encoding:'utf8',mode:0o600});
        return {name,characters:part.characters,chapterCount:part.chapters.length,firstNumber,lastNumber,oversized:part.oversized,
          downloadUrl:`/api/novel-export/file?${new URLSearchParams({projectId,id:requestId,part:String(index)})}`};
      });
      const result:NovelExportResult={id:requestId,projectId,title:snapshot.title,directory,createdAt:new Date().toISOString(),
        chapterCount:formatted.chapterCount,skippedEmptyCount:formatted.skippedEmptyCount,totalCharacters:formatted.totalCharacters,maxCharacters,files};
      const sources=formatted.parts.flatMap(p=>p.chapters.map(c=>({id:c.id,seq:c.seq,number:c.data.number,sha256:createHash('sha256').update(c.data.body).digest('hex')})));
      writeFileSync(join(staging,'manifest.json'),JSON.stringify({...result,sources},null,2),{mode:0o600});
      renameSync(staging,directory);return result;
    }finally{rmSync(staging,{recursive:true,force:true});}
  }
  file(projectId:string,id:string,part:number){
    const directory=this.directory(projectId,id),receipt=join(directory,'manifest.json');
    ensure(existsSync(receipt),'NOT_FOUND','找不到这次小说导出');
    const saved=parse(NovelExportResult,JSON.parse(readFileSync(receipt,'utf8')));
    ensure(Number.isSafeInteger(part)&&part>=0&&part<saved.files.length,'NOT_FOUND','导出文件不存在');
    const file=saved.files[part];
    ensure(file.name===basename(file.name),'VALIDATION','导出文件名无效');
    const path=join(directory,file.name);ensure(existsSync(path),'NOT_FOUND','导出文件已被移走，请重新导出');
    return {path,name:file.name};
  }
}
