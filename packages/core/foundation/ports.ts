import type { z } from 'zod';
import type { Actor, Command, CommandResult, DomainEvent, Kind, RecordState, Ref } from '../../contracts/foundation.ts';

export interface Repository<T> {
  readonly kind: Kind;
  get(id: string, projectId: string): RecordState<T>;
  list(projectId: string): RecordState<T>[];
  create(projectId: string, data: T, id?: string): RecordState<T>;
  save(id: string, projectId: string, expectedSeq: number, data: T): RecordState<T>;
  checkpoint(id: string, projectId: string, expectedSeq: number): Ref;
  at(ref: Ref, projectId: string): RecordState<T>;
  history(id: string, projectId: string): RecordState<T>[];
}
export interface Persistence {
  repository<T>(kind: Kind, schema: z.ZodType<T>): Repository<T>;
  transaction<T>(fn: () => T): T;
  receipt(command: Command, actor: Actor): CommandResult | undefined;
  saveReceipt(command: Command, actor: Actor, result: CommandResult): void;
  append(command: Command, actor: Actor, body: unknown): number;
  events(projectId: string, after: number): DomainEvent[];
  bind(owner: Ref, target: Ref, projectId: string, purpose: string): void;
  dependents(target: Ref, projectId: string): { owner: Ref; purpose: string }[];
}
