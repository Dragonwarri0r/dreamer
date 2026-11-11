import { z } from 'zod';

export const kinds = ['project', 'chapter', 'episode', 'scene', 'resource', 'knowledge', 'shot', 'thread', 'work', 'job', 'artifact', 'cut', 'build', 'change', 'note', 'script'] as const;
export const Kind = z.enum(kinds);
export type Kind = z.infer<typeof Kind>;
export const Id = z.uuid();
export const Ref = z.strictObject({ kind: Kind, id: Id, seq: z.number().int().positive().safe() });
export type Ref = z.infer<typeof Ref>;
export const ProjectData = z.strictObject({
  title: z.string().trim().min(1).max(160), brief: z.string().max(20000).default(''),
  width: z.number().int().min(64).max(4096).default(1280), height: z.number().int().min(64).max(4096).default(720),
  fps: z.number().int().min(1).max(60).default(24), durationSeconds: z.number().min(1).max(3600).default(60),
  language: z.string().max(40).default('中文'), style: z.string().max(2000).default('电影感'),
  generationLimit: z.number().int().min(0).max(1000).default(10),
});
export type ProjectData = z.infer<typeof ProjectData>;
export const Command = z.strictObject({
  requestId: Id, projectId: Id, operation: z.string().min(1).max(100), payload: z.unknown(),
});
export type Command = z.infer<typeof Command>;
export const Expected = z.strictObject({ id: Id, expectedSeq: z.number().int().positive().safe() });
export type RecordState<T> = { id: string; projectId: string; seq: number; data: T; updatedAt: string };
export type DomainEvent = { cursor: number; projectId: string; type: string; commandId: string; source: string; body: unknown; at: string };
export type CommandResult = { requestId: string; result: unknown; cursor: number; replayed?: boolean };
export type Actor = { source: 'human' | 'agent' | 'system' | 'external'; projectId?: string; allowed?: string[]; targets?: string[]; turnId?: string };
export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'IDEMPOTENCY_CONFLICT' | 'UNSUPPORTED' | 'UNKNOWN_OUTCOME' | 'MEDIA_INVALID' | 'BUSY' | 'INTERNAL';
export class DomainError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) { super(message); }
}
export function ensure(condition: unknown, code: ErrorCode, message: string, details?: unknown): asserts condition {
  if (!condition) throw new DomainError(code, message, details);
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError('VALIDATION', '输入不符合业务约定', result.error.issues);
  return result.data;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
