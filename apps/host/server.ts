import {z} from 'zod';
import {handleExperiencePost,handleExperienceGet} from './experience-routes.ts';
import {handleWritingPost,handleWritingGet} from './writing-routes.ts';
import {RuntimePrincipal,type ScriptRelease} from '../../packages/contracts/experience.ts';
import {CloudVideoId} from '../../packages/contracts/cloud-video.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID,timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync, createReadStream,writeFileSync,unlinkSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { DomainError, ensure,Ref,Command,parse } from '../../packages/contracts/foundation.ts';
import type { Application } from './application.ts';
import {SearchQuery} from '../../packages/contracts/longform.ts';
import { MediaFiles } from '../../packages/infra/media.ts';

const equal=(a:string,b:string)=>Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createHost(app: Application, staticRoot=resolve('dist/studio')) {
  const session=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex');
  function json(res:ServerResponse,body:unknown,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const address=server.address();const port=typeof address==='object'&&address?address.port:0;
      const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];ensure(hosts.includes(req.headers.host??''),'FORBIDDEN','Host 不在本地服务范围');
      const origin=`http://${req.headers.host}`;
      ensure(!req.headers.origin||req.headers.origin===origin,'FORBIDDEN','请求来源不匹配');
      const url=new URL(req.url??'/',origin);
      if(url.pathname==='/api/session'&&req.method==='GET'){
        ensure(!req.headers['sec-fetch-site']||['same-origin','none'].includes(String(req.headers['sec-fetch-site'])),'FORBIDDEN','仅允许本地工作台初始化');
        res.setHeader('Set-Cookie',`dreamer=${session}; Path=/; HttpOnly; SameSite=Strict`);return json(res,{csrf,version:'0.1.0',offline:app.offline});
      }
      if(url.pathname.startsWith('/api/')){
        const cookie=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dreamer='))?.slice(8)??'';
        ensure(equal(cookie,session),'FORBIDDEN','请先连接本地工作台');
        if(req.method==='POST'){
          ensure(req.headers.origin===origin&&equal(String(req.headers['x-dreamer-csrf']??''),csrf),'FORBIDDEN','提交来源或会话已失效');
          if(url.pathname==='/api/import'){
            const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;ensure(size<=100*1024*1024,'VALIDATION','网页单次导入最多 100 MiB');chunks.push(chunk);}ensure(size>0,'VALIDATION','导入文件为空');const file=join(app.root,'staging',randomUUID());writeFileSync(file,Buffer.concat(chunks),{mode:0o600});try{return json(res,await app.production.import(url.searchParams.get('projectId')??'',file,(url.searchParams.get('title')??'导入素材').slice(0,200)));}finally{unlinkSync(file);}
          }
          ensure(req.headers['content-type']?.startsWith('application/json'),'VALIDATION','需要 JSON 请求');
          const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;ensure(bytes<=2_000_000,'VALIDATION','请求过大');chunks.push(chunk);}
          let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new DomainError('VALIDATION','JSON 无效');}
          if(url.pathname.startsWith('/api/experience/'))return json(res,await handleExperiencePost(app,url.pathname,String(req.headers['x-dreamer-uid']??''),body));
          if(url.pathname.startsWith('/api/writing/'))return json(res,handleWritingPost(app,url.pathname,body));
          if(url.pathname.startsWith('/api/video-settings'))ensure(!app.offline,'FORBIDDEN','离线 Demo 不保存 Key 或连接外部视频服务');
          if(url.pathname==='/api/video-settings')return json(res,app.videoSettings.save(body));
          if(url.pathname==='/api/novel-export')return json(res,app.novelExporter.export(body));
          if(url.pathname==='/api/video-settings/check'){const id=CloudVideoId.safeParse((body as any)?.id);ensure(id.success,'VALIDATION','视频 Provider 无效');return json(res,await app.cloudVideo.find(p=>p.id===id.data)!.check());}
          if(url.pathname==='/api/commands')return json(res,app.bus.execute(body,{source:'human'}));
          if(url.pathname==='/api/receipt'){const command=parse(Command,body);const receipt=app.store.receipt(command,{source:'human'});return json(res,{found:Boolean(receipt),receipt});}
          if(url.pathname==='/api/backup')return json(res,await app.store.backup(resolve(app.root,'..','backups',`dreamer-${Date.now()}-${randomUUID().slice(0,8)}`)));
          if(url.pathname==='/api/maintenance/cleanup'){const hashes=app.store.mediaHashes();return json(res,new MediaFiles(app.root).cleanup(hashes,true));}
        }else if(req.method==='GET'){
          if(url.pathname==='/api/novel-export/file'){
            const file=app.novelExporter.file(url.searchParams.get('projectId')??'',url.searchParams.get('id')??'',Number(url.searchParams.get('part')??'NaN'));
            res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Content-Length':statSync(file.path).size,'Cache-Control':'no-store'});
            createReadStream(file.path).pipe(res);return;
          }
          if(url.pathname.startsWith('/api/writing/'))return json(res,handleWritingGet(app,url));
          if(url.pathname.startsWith('/api/experience/')){await handleExperienceGet(app,url,req,res);return;}
          if(url.pathname==='/api/instance/media'||url.pathname==='/api/instance/cues'){
            const principal=parse(RuntimePrincipal,{projectId:url.searchParams.get('projectId'),uid:url.searchParams.get('uid')}),runId=url.searchParams.get('runId')??'',instanceId=url.searchParams.get('instanceId')??'';
            const instance=app.experienceRuntime.instance(principal,runId,instanceId),scope={...principal,runId};
            if(url.pathname==='/api/instance/cues'){
              const release=app.store.experience.get<ScriptRelease>('releases',instance.releaseId,{projectId:principal.projectId}).data,node=release.snapshot.nodes.find(n=>n.id===instance.nodeId),contract=node?.type==='segment'&&node.contentSpec.mode!=='fixed'?node.contentSpec.generationContract:undefined;
              return json(res,{cues:release.snapshot.cues.filter(c=>c.segmentNodeId===instance.nodeId),fallbacks:release.policy.failurePolicy==='boundFallback'?(contract?.boundFallbacks.filter(f=>f.outcomeId===instance.outcomeId)??[]):[]});
            }
            const artifact=app.runtimeMedia.preview(scope,{instanceId,resultRevision:Number(url.searchParams.get('resultRevision')),planHash:url.searchParams.get('planHash')??'',bindingId:url.searchParams.get('bindingId')??''}).data,path=app.production.files.path(artifact.sha256),size=statSync(path).size;
            res.setHeader('Content-Type',artifact.mediaType);res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');
            if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);ensure(match,'VALIDATION','媒体范围无效');const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),size-1):size-1;ensure(Number.isSafeInteger(start)&&start>=0&&start<size&&end>=start,'VALIDATION','媒体范围越界');res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});createReadStream(path,{start,end}).pipe(res);return;}res.setHeader('Content-Length',size);createReadStream(path).pipe(res);return;
          }
          if(url.pathname.startsWith('/api/script/')){const pid=url.searchParams.get('projectId')??'',id=url.searchParams.get('id')??'';app.projects.repo.get(pid,pid);if(url.pathname==='/api/script/validate')return json(res,{diagnostics:app.scripts.diagnostics(app.scripts.repo.get(id,pid).data,pid,parse(z.enum(['draft','playback','simulation']),url.searchParams.get('mode')??'draft'))});if(url.pathname==='/api/script/releases')return json(res,{releases:app.scripts.releases(pid,id)});if(url.pathname==='/api/script/impact')return json(res,app.scripts.impact(pid,id));if(url.pathname==='/api/script/media')return json(res,{media:app.scriptMedia(pid)});if(url.pathname==='/api/script/read')return json(res,app.scripts.readPage(pid,parse(Ref,{kind:'script',id,seq:Number(url.searchParams.get('seq'))}),Number(url.searchParams.get('offset')??0),Number(url.searchParams.get('limit')??20)));}
          if(url.pathname==='/api/video-settings')return json(res,app.videoSettings.list());
          if(url.pathname==='/api/search'){const {projectId,...input}=Object.fromEntries(url.searchParams);app.projects.repo.get(projectId,projectId);const q=parse(SearchQuery,{...input,...(input.offset?{offset:Number(input.offset)}:{}),...(input.limit?{limit:Number(input.limit)}:{})});return json(res,app.store.discovery.search(projectId,q));}
          if(url.pathname==='/api/object')return json(res,app.object(url.searchParams.get('projectId')??'',url.searchParams.get('kind')??'',url.searchParams.get('id')??''));
          if(url.pathname==='/api/projects')return json(res,app.store.projects());
          if(url.pathname==='/api/state')return json(res,app.snapshot(url.searchParams.get('projectId')??'',url.searchParams.get('view')==='studio'));
          if(url.pathname==='/api/history'){const repo=app.repositories.get(url.searchParams.get('kind')??'');ensure(repo,'NOT_FOUND','领域不存在');app.object(url.searchParams.get('projectId')??'',url.searchParams.get('kind')??'',url.searchParams.get('id')??'');return json(res,repo.history(url.searchParams.get('id')??'',url.searchParams.get('projectId')??''));}
          if(url.pathname==='/api/revision'){const ref=parse(Ref,{kind:url.searchParams.get('kind'),id:url.searchParams.get('id'),seq:Number(url.searchParams.get('seq'))});const repo=app.repositories.get(ref.kind);ensure(repo,'NOT_FOUND','领域不存在');const row=repo.at(ref,url.searchParams.get('projectId')??'');app.assertPublic(ref.kind,row);return json(res,row);}
          if(url.pathname==='/api/media'){
            const a=app.production.artifacts.get(url.searchParams.get('id')??'',url.searchParams.get('projectId')??'');app.assertPublic('artifact',a);const path=app.production.files.path(a.data.sha256),size=statSync(path).size;res.setHeader('Content-Type',a.data.mediaType);res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','private, max-age=3600');
            if(url.searchParams.get('download')==='1')res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(a.data.title)}.${({'video/mp4':'mp4','image/png':'png','image/jpeg':'jpg','audio/wav':'wav','audio/mpeg':'mp3','audio/mp4':'m4a'} as any)[a.data.mediaType]}`);
            if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);ensure(match,'VALIDATION','媒体范围无效');const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),size-1):size-1;ensure(Number.isSafeInteger(start)&&start>=0&&start<size&&end>=start,'VALIDATION','媒体范围越界');res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});createReadStream(path,{start,end}).pipe(res);return;}res.setHeader('Content-Length',size);createReadStream(path).pipe(res);return;
          }
          if(url.pathname==='/api/events')return json(res,app.store.events(url.searchParams.get('projectId')??'',Number(url.searchParams.get('after')??0)));
          if(url.pathname==='/api/health')return json(res,{...app.store.health(),commands:app.bus.operations()});
          if(url.pathname==='/api/schemas')return json(res,app.bus.schemas());
          if(url.pathname==='/api/maintenance/preview'){const hashes=app.store.mediaHashes();return json(res,new MediaFiles(app.root).cleanup(hashes));}
        }
        throw new DomainError('NOT_FOUND','接口不存在');
      }
      ensure(req.method==='GET','NOT_FOUND','页面不存在');
      const relative=decodeURIComponent(url.pathname);const target=resolve(staticRoot,'.'+relative);
      ensure(target===staticRoot||target.startsWith(staticRoot+sep),'FORBIDDEN','文件路径越界');
      const file=existsSync(target)&&statSync(target).isFile()?target:join(staticRoot,'index.html');
      if(!existsSync(file))return json(res,{message:'请先运行 npm run build'},503);
      const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
      res.setHeader('Content-Type',types[extname(file)]??'application/octet-stream');createReadStream(file).pipe(res);
    }catch(error){const e=error instanceof DomainError?error:new DomainError('INTERNAL','服务处理失败');if(!(error instanceof DomainError))console.error(error);json(res,{error:{code:e.code,message:e.message,details:e.details}},e.code==='FORBIDDEN'?403:e.code==='NOT_FOUND'?404:e.code==='CONFLICT'||e.code==='IDEMPOTENCY_CONFLICT'?409:e.code==='INTERNAL'?500:400);}
  });
  return server;
}
