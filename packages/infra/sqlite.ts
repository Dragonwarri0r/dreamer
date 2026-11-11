import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, writeFileSync, readFileSync, copyFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { kinds, Ref, ProjectData, ensure, parse, stable, type Actor, type Command, type CommandResult, type DomainEvent, type Kind, type RecordState } from '../contracts/foundation.ts';
import type { Persistence, Repository } from '../core/foundation/ports.ts';
import {Catalog} from './catalog.ts';
import {collectCloudRecovery, collectTextRecovery, suspendBackupExecution} from './recovery.ts';
import {ExperienceStore} from './experience-store.ts';
import {STORE_SCHEMA_VERSION, prepareStoreDatabase, migrateStoreSchema, normalizeExperienceBackup, copyRegisteredArtifacts, registeredMediaHashes} from './store-migrations.ts';

const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export function supportsSafeWal(version:string){const [major,minor,patch]=version.split('.').map(Number);return major>3||(major===3&&(minor>51||(minor===51&&patch>=3)||(minor===50&&patch>=7)||(minor===44&&patch>=6)));}
export class SqliteStore implements Persistence {
  private db: DatabaseSync;
  private inTransaction = false;
  readonly discovery:Catalog;
  readonly experience:ExperienceStore;
  readonly migrationBackupPath?:string;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const preparation=prepareStoreDatabase(root);
    this.migrationBackupPath=preparation.backupPath;
    this.db = new DatabaseSync(join(root, 'dreamer.sqlite'));
    const engine=String(this.db.prepare('SELECT sqlite_version() AS v').get()!.v);
    // Node may bundle an older engine. Keep transactional rollback journaling until WAL-reset is fixed.
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA foreign_keys=ON; PRAGMA journal_mode=${supportsSafeWal(engine)?'WAL':'DELETE'}; PRAGMA synchronous=FULL;`);
    try { this.transaction(() => migrateStoreSchema(this.db,kinds)); }
    catch(error) { this.db.close(); throw error; }
    this.experience=new ExperienceStore(this.db,fn=>this.transaction(fn),()=>this.inTransaction);
    this.discovery=new Catalog(this.db);
    chmodSync(join(root, 'dreamer.sqlite'), 0o600);
  }
  mediaHashes(){return registeredMediaHashes(this.db);}
  health() { return { schemaVersion: STORE_SCHEMA_VERSION, sqlite: String(this.db.prepare('SELECT sqlite_version() AS v').get()!.v),journalMode:String(this.db.prepare('PRAGMA journal_mode').get()!.journal_mode) }; }
  transaction<T>(fn: () => T): T {
    ensure(!this.inTransaction, 'INTERNAL', '禁止嵌套业务事务');
    this.inTransaction = true; this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); ensure(!(result instanceof Promise), 'INTERNAL', '事务中不允许异步调用'); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  repository<T>(kind: Kind, schema: z.ZodType<T>): Repository<T> {
    ensure(kinds.includes(kind), 'INTERNAL', '未注册的领域表');
    const decode = (r: any): RecordState<T> => ({ id: r.id, projectId: r.project_id, seq: Number(r.seq), data: parse(schema, JSON.parse(r.body)), updatedAt: r.updated_at });
    const get = (id: string, projectId: string) => {
      const row = this.db.prepare(`SELECT * FROM ${kind}_drafts WHERE id=? AND project_id=?`).get(id, projectId);
      ensure(row, 'NOT_FOUND', '对象不存在或不属于当前项目'); return decode(row);
    };
    return {
      kind, get,
      list: projectId => this.db.prepare(`SELECT * FROM ${kind}_drafts WHERE project_id=? ORDER BY rowid`).all(projectId).map(decode),
      create: (projectId, value, id = randomUUID()) => {
        const data = parse(schema, value); const now = new Date().toISOString();
        ensure(!this.db.prepare(`SELECT id FROM ${kind}_drafts WHERE id=?`).get(id), 'CONFLICT', '对象已存在');
        if (kind !== 'project') ensure(this.db.prepare('SELECT id FROM project_drafts WHERE id=? AND project_id=?').get(projectId, projectId), 'NOT_FOUND', '项目不存在');
        this.db.prepare(`INSERT INTO ${kind}_drafts VALUES(?,?,?,?,?)`).run(id, projectId, 1, stable(data), now);
        return get(id, projectId);
      },
      save: (id, projectId, seq, value) => {
        const data = parse(schema, value); const current = get(id, projectId);
        ensure(current.seq === seq, 'CONFLICT', '草稿已更新，请比较后重新提交', { current });
        const result = this.db.prepare(`UPDATE ${kind}_drafts SET seq=seq+1,body=?,updated_at=? WHERE id=? AND project_id=? AND seq=?`).run(stable(data), new Date().toISOString(), id, projectId, seq);
        ensure(result.changes === 1, 'CONFLICT', '并发修改冲突'); return get(id, projectId);
      },
      checkpoint: (id, projectId, seq) => {
        const current = get(id, projectId); ensure(current.seq === seq, 'CONFLICT', '输入草稿已变化');
        this.db.prepare(`INSERT OR IGNORE INTO ${kind}_revisions VALUES(?,?,?,?,?)`).run(id, projectId, seq, stable(current.data), current.updatedAt);
        return { kind, id, seq };
      },
      at: (ref, projectId) => {
        parse(Ref, ref); ensure(ref.kind === kind, 'VALIDATION', '引用类型不匹配');
        const row = this.db.prepare(`SELECT * FROM ${kind}_revisions WHERE id=? AND project_id=? AND seq=?`).get(ref.id, projectId, ref.seq);
        ensure(row, 'NOT_FOUND', '固定修订不存在'); return decode(row);
      },
      history: (id, projectId) => this.db.prepare(`SELECT * FROM ${kind}_revisions WHERE id=? AND project_id=? ORDER BY seq DESC`).all(id, projectId).map(decode),
    };
  }
  projects() { return this.db.prepare('SELECT id,body,seq,updated_at FROM project_drafts ORDER BY rowid DESC').all().map(r => ({ id: String(r.id), projectId: String(r.id), seq: Number(r.seq), data: parse(ProjectData, JSON.parse(String(r.body))), updatedAt: String(r.updated_at) })); }
  receipt(c: Command, a: Actor): CommandResult | undefined {
    const row = this.db.prepare('SELECT request_hash,body FROM receipts WHERE request_id=?').get(c.requestId);
    if (!row) return;
    ensure(row.request_hash === digest({ c, a }), 'IDEMPOTENCY_CONFLICT', '请求标识已用于其他内容或执行来源'); return JSON.parse(String(row.body));
  }
  saveReceipt(c: Command, a: Actor, result: CommandResult) { this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(c.requestId, digest({ c, a }), stable(result)); }
  append(c: Command, a: Actor, body: unknown) {
    return Number(this.db.prepare('INSERT INTO events(project_id,type,command_id,source,body,at) VALUES(?,?,?,?,?,?)').run(c.projectId, c.operation, c.requestId, a.source, stable(body), new Date().toISOString()).lastInsertRowid);
  }
  events(projectId: string, after: number): DomainEvent[] {
    ensure(Number.isSafeInteger(after) && after >= 0, 'VALIDATION', '事件游标无效');
    return this.db.prepare('SELECT * FROM events WHERE project_id=? AND cursor>? ORDER BY cursor LIMIT 500').all(projectId, after).map(r => ({ cursor: Number(r.cursor), projectId: String(r.project_id), type: String(r.type), commandId: String(r.command_id), source: String(r.source), body: JSON.parse(String(r.body)), at: String(r.at) }));
  }
  bind(owner: Ref, target: Ref, projectId: string, purpose: string) {
    for (const ref of [owner, target]) {
      parse(Ref, ref); ensure(this.db.prepare(`SELECT id FROM ${ref.kind}_revisions WHERE id=? AND project_id=? AND seq=?`).get(ref.id, projectId, ref.seq), 'NOT_FOUND', '引用未冻结或不属于当前项目');
    }
    this.db.prepare('INSERT OR IGNORE INTO dependencies VALUES(?,?,?,?,?,?,?,?)').run(projectId, owner.kind, owner.id, owner.seq, target.kind, target.id, target.seq, purpose);
  }
  dependents(target: Ref, projectId: string) {
    parse(Ref, target);
    return this.db.prepare('SELECT * FROM dependencies WHERE project_id=? AND target_kind=? AND target_id=? AND target_seq=?').all(projectId, target.kind, target.id, target.seq).map(r => ({ owner: { kind: r.owner_kind as Kind, id: String(r.owner_id), seq: Number(r.owner_seq) }, purpose: String(r.purpose) }));
  }
  async backup(destination: string) {
    const target = resolve(destination), source = realpathSync(this.root);
    ensure(target !== source && !target.startsWith(source + sep) && !existsSync(target), 'VALIDATION', '备份必须写入数据目录外的新目录');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    await backup(this.db, join(target, 'dreamer.sqlite'));
    const snapshot = new DatabaseSync(join(target, 'dreamer.sqlite'));
    let files: { hash: string; bytes: number }[] = [];
    let cloudRecovery: ReturnType<typeof collectCloudRecovery>['cloudRecovery'] = [];
    let textRecovery: ReturnType<typeof collectTextRecovery> = [];
    try {
      suspendBackupExecution(snapshot);
      // Include author history, private run media and already-downloaded cloud results.
      files = copyRegisteredArtifacts(snapshot, source, target);
      const recovered = collectCloudRecovery(snapshot, source, target, files);
      files = recovered.files; cloudRecovery = recovered.cloudRecovery;
      textRecovery = collectTextRecovery(snapshot, source);
    } finally { snapshot.close(); }
    const databaseSha256 = createHash('sha256').update(readFileSync(join(target, 'dreamer.sqlite'))).digest('hex');
    writeFileSync(join(target, 'backup.json'), JSON.stringify({ version: 2, createdAt: new Date().toISOString(), files, credentials: 'excluded', runtime: this.health(), databaseSha256, cloudRecovery, textRecovery }, null, 2), { mode: 0o600 });
    return { path: target, files: files.length };
  }
  close() { this.db.close(); }
}
