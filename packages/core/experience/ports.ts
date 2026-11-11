/** Private experience data never participates in the author project snapshot. */
export const experienceCollections = [
  'releases', 'runs', 'visits', 'activities', 'instances', 'results',
  'dispatches', 'effects', 'positions', 'mediaLinks', 'reservations', 'exports',
] as const;
export type ExperienceCollection = typeof experienceCollections[number];
export type ExperienceScope = { projectId: string; uid?: string; runId?: string };
export type RunScope = { projectId: string; uid: string; runId: string };
export type ExperienceRow<T = Record<string, unknown>> = ExperienceScope & {
  id: string;
  seq: number;
  data: T;
  createdAt: string;
  updatedAt: string;
};
export type ExperienceEvent = RunScope & {
  cursor: number;
  type: string;
  commandId: string;
  body: unknown;
  at: string;
};
export type GenerationReservation = {
  requestId: string;
  ownerKey: string;
  stage: string;
  attemptNo: number;
  unit: 'text' | 'media';
  countsProject: boolean;
  state: 'reserved' | 'dispatched' | 'consumed' | 'unknown' | 'failed' | 'cancelled' | 'released';
  source: 'legacy' | 'runtime' | 'author';
  jobId?: string;
  dispatchId?: string;
  provider?: string;
};
export type GenerationUsage = { projectMedia: number; runText: number; runMedia: number };

/** Methods are synchronous. The caller owns the single outer transaction. */
export interface ExperiencePersistence {
  transaction<T>(fn: () => T): T;
  /** Host-only recovery lookup. Never expose through a viewer route. */
  lookupRun<T = Record<string, unknown>>(projectId: string, runId: string): ExperienceRow<T>;
  /** Host-only startup enumeration; viewer APIs must always supply a uid. */
  runScopes(projectId: string): RunScope[];
  create<T>(collection: ExperienceCollection, scope: ExperienceScope, data: T, id?: string): ExperienceRow<T>;
  get<T = Record<string, unknown>>(collection: ExperienceCollection, id: string, scope: ExperienceScope): ExperienceRow<T>;
  list<T = Record<string, unknown>>(collection: ExperienceCollection, scope: ExperienceScope): ExperienceRow<T>[];
  save<T>(collection: ExperienceCollection, id: string, scope: ExperienceScope, expectedSeq: number, data: T): ExperienceRow<T>;
  receipt<T = unknown>(scope: ExperienceScope, requestId: string, input: unknown): T | undefined;
  saveReceipt(scope: ExperienceScope, requestId: string, input: unknown, result: unknown): void;
  append(scope: RunScope, type: string, body: unknown, commandId?: string): number;
  events(scope: RunScope, after: number): ExperienceEvent[];
  usage(scope: ExperienceScope): GenerationUsage;
  reserve(scope: ExperienceScope, data: GenerationReservation, limits: { projectMedia: number; runText?: number; runMedia?: number }, id?: string): ExperienceRow<GenerationReservation>;
}
