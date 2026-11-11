import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { DomainError, ensure, Id, parse } from '../../packages/contracts/foundation.ts';
import { RuntimePrincipal } from '../../packages/contracts/experience.ts';
import { experienceCatalog } from '../../packages/core/experience/catalog.ts';
import type { Application } from './application.ts';

/** The parent HTTP router has already applied local session, Origin, CSRF and body limits. */
export function handleExperiencePost(app: Application, pathname: string, uid: string, raw: unknown) {
  ensure(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'VALIDATION', '体验请求需要对象');
  const body = raw as Record<string, unknown>, principal = parse(RuntimePrincipal, { projectId: body.projectId, uid });
  const { projectId: _projectId, ...input } = body;
  if (pathname === '/api/experience/export-video') return app.experienceExporter.start(principal, input);
  if (pathname === '/api/experience/export-retry') return app.experienceExporter.retry(principal, input);
  if (pathname === '/api/experience/start') return app.experienceRuntime.start(principal, body as any);
  if (pathname === '/api/experience/commands') return app.experienceRuntime.execute(principal, input as any);
  if (pathname === '/api/experience/position') return app.experienceRuntime.positionSave(principal, input as any);
  if (pathname === '/api/experience/receipt') {
    const receipt = app.experienceRuntime.receipt(principal, 'releaseId' in body ? body as any : input as any);
    return { found: receipt !== undefined, receipt };
  }
  throw new DomainError('NOT_FOUND', '体验接口不存在');
}

export function handleExperienceGet(app: Application, url: URL, req: IncomingMessage, res: ServerResponse) {
  const json = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/experience/catalog') {
    const projectId = parse(Id, url.searchParams.get('projectId'));
    app.projects.repo.get(projectId, projectId);
    return json(experienceCatalog(app.store.experience, projectId, {
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
    }));
  }
  const principal = parse(RuntimePrincipal, { projectId: url.searchParams.get('projectId'), uid: url.searchParams.get('uid') });
  const runId = url.searchParams.get('runId') ?? '';
  switch (url.pathname) {
    case '/api/experience/history': return json(app.experienceArchives.history(principal,runId));
    case '/api/experience/exports': return json({exports:app.experienceArchives.list(principal,runId)});
    case '/api/experience/export-status': return json({export:app.experienceArchives.get(principal,runId,url.searchParams.get('exportId')??'')});
    case '/api/experience/export-manifest': {const record=app.experienceArchives.get(principal,runId,url.searchParams.get('exportId')??'');res.setHeader('Content-Disposition',`attachment; filename=experience-${record.id}-manifest.json`);return json(record);}
    case '/api/experience/export-video': {const {record,path}=app.experienceExporter.download(principal,runId,url.searchParams.get('exportId')??'');res.setHeader('Content-Disposition',`attachment; filename=experience-${record.id}.mp4`);return streamPrivateMedia(req,res,path,'video/mp4');}
    case '/api/experience/runs': return json({ runs: app.experienceRuntime.runs(principal) });
    case '/api/experience/run': return json(app.experienceRuntime.view(principal, runId));
    case '/api/experience/export': {const view=app.experienceRuntime.view(principal,runId),trace=app.experienceRuntime.trace(principal,runId);const instances=trace.visits.filter(v=>v.status==='completed'&&v.instanceId).map(v=>app.experienceRuntime.instance(principal,runId,v.instanceId!)).filter(instance=>instance.status==='consumed');res.setHeader('Content-Disposition',`attachment; filename=experience-${runId}.json`);return json({schemaVersion:1,format:'dreamer-experienced-route',run:view.run,visits:trace.visits,instances,effects:view.run.committedFacts,media:instances.filter(i=>i.status==='consumed').flatMap(i=>i.playbackPlan?.bindings??[]),exportedAt:new Date().toISOString()});}
    case '/api/experience/trace': return json(app.experienceRuntime.tracePage(principal, runId, {
      ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
      ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
    }));
    case '/api/experience/events': return json({ events: app.experienceRuntime.events(principal, runId, Number(url.searchParams.get('after') ?? 0)) });
    case '/api/experience/instance': return json({ instance: app.experienceRuntime.instance(principal, runId, url.searchParams.get('instanceId') ?? '') });
    case '/api/experience/activity': return json({ attempt: app.experienceRuntime.activity(principal, runId, url.searchParams.get('attemptId') ?? '') });
    case '/api/experience/media': {
      const artifact = app.experienceRuntime.media(principal, runId, url.searchParams.get('planHash') ?? '', url.searchParams.get('bindingId') ?? '');
      return streamPrivateMedia(req,res,app.production.files.path(artifact.data.sha256),artifact.data.mediaType);
    }
    default: throw new DomainError('NOT_FOUND', '体验接口不存在');
  }
}
function streamPrivateMedia(req:IncomingMessage,res:ServerResponse,path:string,mediaType:string){
 const size=statSync(path).size;res.setHeader('Content-Type',mediaType);res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','private, no-store');
 if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);ensure(match,'VALIDATION','媒体范围无效');const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),size-1):size-1;ensure(Number.isSafeInteger(start)&&start>=0&&start<size&&end>=start,'VALIDATION','媒体范围越界');res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});createReadStream(path,{start,end}).pipe(res);return;}
 res.setHeader('Content-Length',size);createReadStream(path).pipe(res);
}
