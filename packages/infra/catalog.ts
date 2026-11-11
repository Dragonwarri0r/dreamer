import type {DatabaseSync} from 'node:sqlite';
import {SearchQuery,type SearchResult} from '../contracts/longform.ts';
import {ensure,parse} from '../contracts/foundation.ts';

const fields:Record<string,string[]>={
  chapter:['title','number','volume','status','tags'],
  scene:['title','order','chapterId','location','time'],
  shot:['title','order','scene','durationFrames','archived','adoptedTakeId'],
  resource:['title','type','status','entityId'],
  knowledge:['title','category','tags','confirmed'],
  episode:['title','chapterIds','shotIds','shotFrames','targetSeconds','status'],
  thread:['title','workId','state','error','lease','delegation'],
  script:['title','schemaVersion','entryNodeId'],
};
const jsonFields=new Set(['tags','scene','chapterIds','shotIds','shotFrames','lease','delegation']);
const textField:Record<string,string>={chapter:'body',scene:'synopsis',shot:'action',resource:'description',knowledge:'text',episode:'brief',thread:'title',script:'title'};
const decode=(r:any)=>({id:r.id,projectId:r.project_id,seq:Number(r.seq),updatedAt:r.updated_at,summaryOnly:true,data:JSON.parse(r.summary)});
/** Read only small projections. Novel bodies never cross the Studio snapshot boundary. */
export class Catalog{
  constructor(private db:DatabaseSync){}
  private projection(kind:string){
    ensure(fields[kind],'VALIDATION','此类型没有目录');
    const j=(key:string)=>`json_extract(body,'$.${key}')`;
    const values=fields[kind].flatMap(key=>[`'${key}'`,jsonFields.has(key)?`json(${j(key)})`:j(key)]);
    if(kind==='chapter')values.push("'synopsis'",`substr(coalesce(${j('synopsis')},''),1,400)`,"'charCount'",`length(coalesce(${j('body')},''))`);
    if(kind==='scene')values.push("'synopsis'",`substr(coalesce(${j('synopsis')},''),1,400)`,"'blockCount'",`coalesce(json_array_length(body,'$.blocks'),0)`,"'blocks'","json('[]')","'bindings'","json('[]')");
    if(kind==='shot')values.push("'intent'",`substr(coalesce(${j('intent')},''),1,200)`,"'action'",`substr(coalesce(${j('action')},''),1,200)`,"'panelCount'",`coalesce(json_array_length(body,'$.panels'),0)`,"'takeCount'",`coalesce(json_array_length(body,'$.takes'),0)`,"'panels'",`json(coalesce((SELECT json_group_array(json_object('artifact',json_extract(value,'$.artifact'))) FROM json_each(body,'$.panels') WHERE json_extract(value,'$.artifact') IS NOT NULL),'[]'))`,"'takes'","json('[]')");
    if(kind==='knowledge')values.push("'text'",`substr(coalesce(${j('text')},''),1,300)`);
    if(kind==='episode')values.push("'brief'",`substr(coalesce(${j('brief')},''),1,300)`);
    if(kind==='thread')values.push("'entries'","json('[]')","'turns'","json('[]')","'anchors'","json('[]')","'bindings'","json('[]')");
    if(kind==='script')values.push("'nodeCount'","coalesce(json_array_length(body,'$.nodes'),0)","'variableCount'","coalesce(json_array_length(body,'$.variables'),0)");
    return `json_object(${values.join(',')})`;
  }
  catalog(pid:string,kind:string){
    const projection=this.projection(kind);
    const order=kind==='chapter'?"coalesce(json_extract(body,'$.number'),0),id":['scene','shot'].includes(kind)?"coalesce(json_extract(body,'$.order'),0),id":'rowid';
    return this.db.prepare(`SELECT id,project_id,seq,updated_at,${projection} AS summary FROM ${kind}_drafts WHERE project_id=? ORDER BY ${order}`).all(pid).map(decode);
  }
  search(pid:string,input:SearchQuery):SearchResult{
    const p=parse(SearchQuery,input),kinds=p.kind==='all'?['chapter','scene','shot','resource','knowledge','episode','script']:[p.kind];
    let episode:any;
    if(p.episodeId){const row=this.db.prepare('SELECT body FROM episode_drafts WHERE id=? AND project_id=?').get(p.episodeId,pid);ensure(row,'NOT_FOUND','制作单不存在');episode=JSON.parse(String(row.body));}
    const items:any[]=[];let total=0,skip=p.offset;
    const number=/^(?:#|第)\s*(\d+)\s*章?$/.exec(p.query.trim());
    for(const kind of kinds){
      const j=(key:string)=>`json_extract(d.body,'$.${key}')`;
      const chapter=kind==='chapter'?'d.id':kind==='scene'?j('chapterId'):kind==='shot'?`(SELECT json_extract(s.body,'$.chapterId') FROM scene_drafts s WHERE s.id=${j('scene.id')} AND s.project_id=d.project_id)`:'NULL';
      const text=kind==='scene'?`${j('title')}||' '||coalesce(${j('synopsis')},'')||' '||coalesce((SELECT group_concat(json_extract(value,'$.text'),' ') FROM json_each(d.body,'$.blocks')),'')`:
        `${j('title')}||' '||coalesce(${j('synopsis')},'')||' '||coalesce(${j(textField[kind])},'')`;
      const clauses=['d.project_id=?'],args:any[]=[pid];
      if(kind==='shot')clauses.push(`coalesce(${j('archived')},0)=0`);
      if(p.chapterId){clauses.push(`${chapter}=?`);args.push(p.chapterId);}
      if(episode){const ids=kind==='shot'?episode.shotIds:episode.chapterIds;clauses.push(`${kind==='shot'?'d.id':chapter} IN (SELECT value FROM json_each(?))`);args.push(JSON.stringify(ids));}
      if(p.volume!==undefined){clauses.push(`${kind==='chapter'?j('volume'):`(SELECT json_extract(c.body,'$.volume') FROM chapter_drafts c WHERE c.id=${chapter} AND c.project_id=d.project_id)`}=?`);args.push(p.volume);}
      if(p.status){clauses.push(`${j('status')}=?`);args.push(p.status);}
      if(number){clauses.push(kind==='chapter'?`${j('number')}=?`:'0');if(kind==='chapter')args.push(Number(number[1]));}
      else if(p.query.trim()){clauses.push(`instr(lower(${text}),lower(?))>0`);args.push(p.query.trim());}
      const where=clauses.join(' AND '),count=Number(this.db.prepare(`SELECT count(*) AS n FROM ${kind}_drafts d WHERE ${where}`).get(...args)!.n);
      total+=count;if(skip>=count){skip-=count;continue;}if(items.length>=p.limit)continue;
      const order=episode&&kind==='shot'?`(SELECT key FROM json_each(?) WHERE value=d.id)`:kind==='chapter'?`${j('number')},d.id`:['scene','shot'].includes(kind)?`${j('order')},d.id`:'d.rowid';
      const excerpt=`substr(${text},max(1,instr(lower(${text}),lower(?))-40),180)`;
      const rows=this.db.prepare(`SELECT d.id,d.project_id,d.seq,d.updated_at,${this.projection(kind).replaceAll(/(json_extract|json_array_length|json_each)\(body,/g,'$1(d.body,')} AS summary,${excerpt} AS excerpt,${chapter} AS chapter_id FROM ${kind}_drafts d WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(p.query.trim(),...args,...(episode&&kind==='shot'?[JSON.stringify(episode.shotIds)]:[]),p.limit-items.length,skip);
      items.push(...rows.map((r:any)=>({...decode(r),kind,excerpt:r.excerpt,chapterId:r.chapter_id})));skip=0;
    }
    return {items,total,offset:p.offset,limit:p.limit,nextOffset:p.offset+items.length<total?p.offset+items.length:null};
  }
}
