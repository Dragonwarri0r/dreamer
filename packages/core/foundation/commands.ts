import { z } from 'zod';
import { Command, ProjectData, Expected, ensure, parse, type Actor, type CommandResult } from '../../contracts/foundation.ts';
import type { Persistence, Repository } from './ports.ts';

type Handler = { schema: z.ZodType; human: boolean; execute: (payload: any, projectId: string, actor: Actor) => unknown; projectEvent?: (result: any) => unknown };
export class CommandBus {
  private handlers = new Map<string, Handler>();
  constructor(readonly store: Persistence) {}
  register<T, R>(operation: string, schema: z.ZodType<T>, execute: (payload: T, projectId: string, actor: Actor) => R, human = false, projectEvent?: (result: R) => unknown) {
    ensure(!this.handlers.has(operation), 'INTERNAL', `重复业务入口 ${operation}`);
    this.handlers.set(operation, { schema, execute, human, projectEvent });
  }
  schemas() { return Object.fromEntries([...this.handlers].map(([name,h]) => [name, z.toJSONSchema(h.schema,{reused:'ref'})])); }
  operations() { return [...this.handlers].map(([name,h]) => ({ name, humanOnly: h.human })); }
  execute(input: unknown, actor: Actor): CommandResult {
    const command = parse(Command, input);
    const handler = this.handlers.get(command.operation);
    ensure(handler, 'NOT_FOUND', '业务操作不存在');
    ensure(!actor.projectId || actor.projectId === command.projectId, 'FORBIDDEN', '项目范围不匹配');
    if (actor.source === 'external') ensure(['writing.start','writing.continue'].includes(command.operation),'FORBIDDEN','外部调用请通过平台写作 Agent，不能直接修改或批准内容');
    if (actor.source === 'agent' || actor.source === 'external') {
      ensure(!handler.human && actor.allowed?.includes(command.operation), 'FORBIDDEN', '此操作需要用户决定或超出执行范围');
    }
    const payload = parse(handler.schema, command.payload);
    return this.store.transaction(() => {
      const prior = this.store.receipt(command, actor);
      if (prior) return { ...prior, replayed: true };
      const result = handler.execute(payload, command.projectId, actor);
      ensure(!(result instanceof Promise), 'INTERNAL', '业务事务中不能等待外部执行');
      // Public project events may expose less than the explicit command response and its private receipt.
      const eventBody = handler.projectEvent ? handler.projectEvent(result) : result;
      ensure(!(eventBody instanceof Promise), 'INTERNAL', '事件投影不能等待外部执行');
      const cursor = this.store.append(command, actor, eventBody);
      const receipt = { requestId: command.requestId, result, cursor };
      this.store.saveReceipt(command, actor, receipt);
      return receipt;
    });
  }
}
export function checkTarget(actor: Actor, id: string) {
  if (actor.source === 'agent' && actor.targets?.length) ensure(actor.targets.includes(id), 'FORBIDDEN', '目标不在本轮授权范围');
}
export class Projects {
  readonly repo: Repository<ProjectData>;
  constructor(store: Persistence, bus: CommandBus) {
    this.repo = store.repository('project', ProjectData);
    bus.register('project.create', ProjectData, (p, projectId) => this.repo.create(projectId, p, projectId));
    bus.register('project.update', Expected.extend({ data: ProjectData }), (p, projectId, actor) => {
      checkTarget(actor, p.id); return this.repo.save(p.id, projectId, p.expectedSeq, p.data);
    });
  }
}
