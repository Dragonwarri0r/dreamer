import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { ensure, stable } from '../contracts/foundation.ts';
import type {
  ExperienceCollection, ExperiencePersistence, ExperienceRow, ExperienceScope, RunScope,
  GenerationReservation, GenerationUsage,
} from '../core/experience/ports.ts';
import { experienceTables } from './store-migrations.ts';

const immutable = new Set<ExperienceCollection>(['releases', 'results', 'effects', 'mediaLinks']);
const identityFields: Partial<Record<ExperienceCollection, string[]>> = {
  releases: ['scriptRef', 'manifestHash'], runs: ['releaseId'], visits: ['nodeId'], exports: ['runId', 'planHash', 'requestId'],
  activities: ['visitId'], instances: ['visitId', 'inputHash'], results: ['instanceId', 'resultRevision'],
  dispatches: ['requestId', 'ownerKey', 'stage', 'attemptNo'], effects: ['visitId', 'phase', 'effectId'],
  positions: ['visitId'], mediaLinks: ['instanceId', 'bindingId'],
  reservations: ['requestId', 'ownerKey', 'stage', 'attemptNo', 'unit', 'countsProject', 'source'],
};
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

/** Receives the infra connection; core only sees ExperiencePersistence. */
export class ExperienceStore implements ExperiencePersistence {
  constructor(private db: DatabaseSync, private transact: <T>(fn: () => T) => T, private isInTransaction: () => boolean) {}
  transaction<T>(fn: () => T) { return this.transact(fn); }
  lookupRun<T = Record<string, unknown>>(projectId: string, runId: string): ExperienceRow<T> {
    const row = this.db.prepare('SELECT * FROM experience_runs WHERE project_id=? AND id=?').get(projectId, runId);
    ensure(row, 'NOT_FOUND', '体验不存在或不属于当前项目');
    return this.decode<T>(row);
  }
  runScopes(projectId: string): RunScope[] {
    return this.db.prepare('SELECT uid,id FROM experience_runs WHERE project_id=?').all(projectId)
      .map(row => ({ projectId, uid: String(row.uid), runId: String(row.id) }));
  }

  private scope(collection: ExperienceCollection, scope: ExperienceScope, id?: string) {
    ensure(Object.hasOwn(experienceTables, collection), 'VALIDATION', '未知体验记录类型');
    ensure(typeof scope.projectId === 'string' && scope.projectId.length > 0, 'VALIDATION', '缺少项目范围');
    const uid = scope.uid ?? '', runId = scope.runId ?? '';
    if (collection === 'releases') ensure(!uid && !runId, 'VALIDATION', '发布版本使用项目范围');
    else if (collection === 'runs') {
      ensure(uid.length > 0 && (!id || !runId || id === runId), 'VALIDATION', '体验归属不匹配');
    } else if (collection !== 'reservations' || uid || runId) {
      ensure(uid.length > 0 && runId.length > 0, 'VALIDATION', '体验数据必须包含 uid 和 runId');
      this.assertRun({ projectId: scope.projectId, uid, runId });
    }
    return { projectId: scope.projectId, uid, runId };
  }
  private assertRun(scope: RunScope) {
    ensure(this.db.prepare('SELECT id FROM experience_runs WHERE project_id=? AND uid=? AND id=?').get(scope.projectId, scope.uid, scope.runId), 'NOT_FOUND', '体验不存在或不属于当前用户');
  }
  private decode<T>(row: Record<string, unknown>): ExperienceRow<T> {
    return { id: String(row.id), projectId: String(row.project_id), ...(row.uid ? { uid: String(row.uid) } : {}),
      ...(row.run_id ? { runId: String(row.run_id) } : {}), seq: Number(row.seq), data: JSON.parse(String(row.body)),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  private write<T>(fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof Error && /(?:UNIQUE|PRIMARY KEY|FOREIGN KEY|CHECK|NOT NULL) constraint failed/.test(error.message)) {
        ensure(false, 'CONFLICT', '体验记录身份重复、关联失效或约束不满足');
      }
      throw error;
    }
  }
  private validate(collection: ExperienceCollection, scope: ExperienceScope, data: unknown) {
    ensure(data !== null && typeof data === 'object' && !Array.isArray(data), 'VALIDATION', '体验记录必须是对象');
    const body = data as Record<string, unknown>;
    for (const key of identityFields[collection] ?? []) {
      ensure(body[key] !== undefined && body[key] !== null && body[key] !== '', 'VALIDATION', `体验记录缺少 ${key}`);
    }
    for (const key of ['projectId', 'uid', 'runId'] as const) {
      if (body[key] !== undefined) ensure(body[key] === scope[key], 'VALIDATION', `体验记录 ${key} 不匹配`);
    }
    for (const key of ['attemptNo', 'resultRevision']) {
      if (body[key] !== undefined) ensure(Number.isSafeInteger(body[key]) && Number(body[key]) > 0, 'VALIDATION', `${key} 必须为正整数`);
    }
    for (const [field, target] of [['visitId', 'visits'], ['instanceId', 'instances']] as const) {
      if (body[field] !== undefined) this.get(target, String(body[field]), scope);
    }
    if (collection === 'runs') this.get('releases', String(body.releaseId), { projectId: scope.projectId });
  }
  create<T>(collection: ExperienceCollection, scope: ExperienceScope, data: T, id: string = randomUUID()): ExperienceRow<T> {
    const normalized = this.scope(collection, scope, id);
    if (collection === 'runs') normalized.runId = id;
    ensure(this.db.prepare('SELECT id FROM project_drafts WHERE id=? AND project_id=?').get(scope.projectId, scope.projectId), 'NOT_FOUND', '项目不存在');
    this.validate(collection, normalized, data);
    const now = new Date().toISOString();
    this.write(() => this.db.prepare(`INSERT INTO ${experienceTables[collection]}(id,project_id,uid,run_id,seq,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id, normalized.projectId, normalized.uid, normalized.runId, 1, stable(data), now, now));
    return this.get(collection, id, normalized);
  }
  get<T = Record<string, unknown>>(collection: ExperienceCollection, id: string, scope: ExperienceScope): ExperienceRow<T> {
    const normalized = this.scope(collection, scope, id);
    const runClause = collection === 'runs' && !normalized.runId ? '' : ' AND run_id=?';
    const params = [id, normalized.projectId, normalized.uid, ...(runClause ? [normalized.runId] : [])];
    const row = this.db.prepare(`SELECT * FROM ${experienceTables[collection]} WHERE id=? AND project_id=? AND uid=?${runClause}`).get(...params);
    ensure(row, 'NOT_FOUND', '体验记录不存在或不属于当前范围');
    return this.decode<T>(row);
  }
  list<T = Record<string, unknown>>(collection: ExperienceCollection, scope: ExperienceScope): ExperienceRow<T>[] {
    const normalized = this.scope(collection, scope);
    const runClause = collection === 'runs' && !normalized.runId ? '' : ' AND run_id=?';
    return this.db.prepare(`SELECT * FROM ${experienceTables[collection]} WHERE project_id=? AND uid=?${runClause} ORDER BY rowid`)
      .all(normalized.projectId, normalized.uid, ...(runClause ? [normalized.runId] : [])).map(row => this.decode<T>(row));
  }
  save<T>(collection: ExperienceCollection, id: string, scope: ExperienceScope, expectedSeq: number, data: T): ExperienceRow<T> {
    ensure(!immutable.has(collection), 'FORBIDDEN', '固定发布、结果、效果和媒体绑定不可修改');
    const current = this.get<Record<string, unknown>>(collection, id, scope);
    ensure(current.seq === expectedSeq, 'CONFLICT', '体验状态已更新，请刷新后重试');
    this.validate(collection, current, data);
    const body = data as Record<string, unknown>;
    for (const key of identityFields[collection] ?? []) ensure(stable(current.data[key]) === stable(body[key]), 'CONFLICT', `不可修改体验记录身份 ${key}`);
    if (collection === 'reservations' && body.state === 'released') ensure(current.data.state === 'reserved' || current.data.state === 'released', 'CONFLICT', '已派发或结果未知的预约不可退还');
    const normalized = this.scope(collection, current, id);
    const changed = this.write(() => this.db.prepare(`UPDATE ${experienceTables[collection]} SET body=?,seq=seq+1,updated_at=? WHERE id=? AND project_id=? AND uid=? AND run_id=? AND seq=?`)
      .run(stable(data), new Date().toISOString(), id, normalized.projectId, normalized.uid, normalized.runId, expectedSeq));
    ensure(changed.changes === 1, 'CONFLICT', '体验状态并发更新');
    return this.get(collection, id, current);
  }
  private receiptScope(scope: ExperienceScope) {
    ensure(scope.projectId && scope.uid, 'VALIDATION', '回执需要项目与用户范围');
    if (scope.runId) this.assertRun(scope as RunScope);
    return { projectId: scope.projectId, uid: scope.uid, runId: scope.runId ?? '' };
  }
  receipt<T = unknown>(scope: ExperienceScope, requestId: string, input: unknown): T | undefined {
    const s = this.receiptScope(scope);
    const row = this.db.prepare('SELECT request_hash,body FROM experience_receipts WHERE project_id=? AND uid=? AND run_id=? AND request_id=?').get(s.projectId, s.uid, s.runId, requestId);
    if (!row) return;
    ensure(row.request_hash === hash({ scope: s, input }), 'IDEMPOTENCY_CONFLICT', '请求标识已用于其他体验输入');
    return JSON.parse(String(row.body));
  }
  saveReceipt(scope: ExperienceScope, requestId: string, input: unknown, result: unknown) {
    const s = this.receiptScope(scope);
    this.write(() => this.db.prepare('INSERT INTO experience_receipts VALUES(?,?,?,?,?,?)').run(s.projectId, s.uid, s.runId, requestId, hash({ scope: s, input }), stable(result)));
  }
  append(scope: RunScope, type: string, body: unknown, commandId = randomUUID()) {
    this.assertRun(scope);
    return Number(this.db.prepare('INSERT INTO experience_events(project_id,uid,run_id,type,command_id,body,at) VALUES(?,?,?,?,?,?,?)')
      .run(scope.projectId, scope.uid, scope.runId, type, commandId, stable(body), new Date().toISOString()).lastInsertRowid);
  }
  events(scope: RunScope, after: number) {
    this.assertRun(scope);
    ensure(Number.isSafeInteger(after) && after >= 0, 'VALIDATION', '体验事件游标无效');
    return this.db.prepare('SELECT * FROM experience_events WHERE project_id=? AND uid=? AND run_id=? AND cursor>? ORDER BY cursor LIMIT 500')
      .all(scope.projectId, scope.uid, scope.runId, after).map(row => ({ ...scope, cursor: Number(row.cursor), type: String(row.type), commandId: String(row.command_id), body: JSON.parse(String(row.body)), at: String(row.at) }));
  }
  usage(scope: ExperienceScope): GenerationUsage {
    if (scope.uid || scope.runId) this.assertRun(scope as RunScope);
    const rows = this.db.prepare("SELECT uid,run_id,body FROM generation_reservations WHERE project_id=? AND json_extract(body,'$.state')<>'released'").all(scope.projectId);
    let projectMedia = 0, runText = 0, runMedia = 0;
    for (const row of rows) {
      const data: GenerationReservation = JSON.parse(String(row.body));
      if (data.countsProject) projectMedia += 1;
      if (scope.runId && row.uid === scope.uid && row.run_id === scope.runId) {
        if (data.unit === 'text') runText += 1; else runMedia += 1;
      }
    }
    return { projectMedia, runText, runMedia };
  }
  reserve(scope: ExperienceScope, data: GenerationReservation, limits: { projectMedia: number; runText?: number; runMedia?: number }, id?: string) {
    ensure(this.isInTransaction(), 'INTERNAL', '预算预约必须属于外层事务');
    ensure(data.state === 'reserved' && data.source !== 'legacy', 'VALIDATION', '新预约必须从 reserved 开始');
    for (const value of Object.values(limits)) ensure(Number.isSafeInteger(value) && value >= 0, 'VALIDATION', '预算必须为非负整数');
    const used = this.usage(scope);
    ensure(!data.countsProject || used.projectMedia < limits.projectMedia, 'FORBIDDEN', '项目生成次数预算已用完');
    if (scope.runId) {
      const limit = data.unit === 'text' ? limits.runText : limits.runMedia;
      ensure(limit !== undefined && (data.unit === 'text' ? used.runText : used.runMedia) < limit, 'FORBIDDEN', '本次体验生成预算已用完');
    }
    return this.create('reservations', scope, data, id);
  }
}
