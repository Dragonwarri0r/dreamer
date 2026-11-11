import {WritingStartRequest,WritingContinueRequest,WritingReceiptRequest,WritingStatusQuery,writingActor} from '../../packages/contracts/writing.ts';
import {DomainError,parse} from '../../packages/contracts/foundation.ts';
import type {Application} from './application.ts';

/** External assistants receive workflow handles, never a generic human command channel. */
export function handleWritingPost(app:Application,path:string,body:unknown){
 if(path==='/api/writing/receipt'){
  const command=parse(WritingReceiptRequest,body),receipt=app.store.receipt(command,writingActor(command.projectId));
  return {found:Boolean(receipt),receipt};
 }
 if(path==='/api/writing/start'){
  const {requestId,projectId,...payload}=parse(WritingStartRequest,body);
  return app.bus.execute({requestId,projectId,operation:'writing.start',payload},writingActor(projectId));
 }
 if(path==='/api/writing/continue'){
  const {requestId,projectId,...payload}=parse(WritingContinueRequest,body);
  return app.bus.execute({requestId,projectId,operation:'writing.continue',payload},writingActor(projectId));
 }
 throw new DomainError('NOT_FOUND','写作接口不存在');
}
export function handleWritingGet(app:Application,url:URL){
 if(url.pathname==='/api/writing/status'){
  const {projectId,threadId,afterEntryId}=parse(WritingStatusQuery,Object.fromEntries(url.searchParams));
  return app.agents.writingStatus(projectId,threadId,afterEntryId);
 }
 throw new DomainError('NOT_FOUND','写作接口不存在');
}
