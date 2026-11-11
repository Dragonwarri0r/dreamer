import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ensure, stable, type Kind } from '../contracts/foundation.ts';
import type { ExperienceCollection } from '../core/experience/ports.ts';

export const STORE_SCHEMA_VERSION = 4;
export const experienceTables: Record<ExperienceCollection, string> = {
  releases: 'script_releases', runs: 'experience_runs', visits: 'experience_visits',
  activities: 'experience_activities', instances: 'experience_instances', results: 'experience_results',
  dispatches: 'experience_dispatches', effects: 'experience_effects', positions: 'experience_positions',
  mediaLinks: 'experience_media_links', reservations: 'generation_reservations', exports: 'experience_exports',
};
const projectMediaProviders = new Set(['ltx', 'h3', 'codex-image', 'seedance', 'wan', 'fal-h3']);

export function databaseVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()!.user_version);
}

/** Synchronous bootstrap: no application, Provider, PRAGMA write or migration has run yet. */
export function prepareStoreDatabase(root: string): { version: number; backupPath?: string } {
  const path = join(root, 'dreamer.sqlite');
  if (!existsSync(path)) return { version: 0 };
  const source = new DatabaseSync(path, { readOnly: true });
  let backupPath: string | undefined;
  try {
    const version = databaseVersion(source);
    ensure(version >= 0 && version <= STORE_SCHEMA_VERSION, 'UNSUPPORTED', '数据版本高于当前应用，拒绝写入');
    if (version === STORE_SCHEMA_VERSION) return { version };
    const absoluteRoot = realpathSync(root);
    backupPath = join(dirname(absoluteRoot), `.dreamer-before-schema${STORE_SCHEMA_VERSION}-${randomUUID()}`);
    mkdirSync(backupPath, { mode: 0o700 });
    // Unlike copying a live DB file, VACUUM INTO includes committed WAL contents.
    source.prepare('VACUUM INTO ?').run(join(backupPath, 'dreamer.sqlite'));
    chmodSync(join(backupPath, 'dreamer.sqlite'), 0o600);
    const files = copyRegisteredArtifacts(source, absoluteRoot, backupPath);
    writeFileSync(join(backupPath, 'backup.json'), JSON.stringify({
      version: 1, purpose: 'before-schema-migration', createdAt: new Date().toISOString(),
      files, credentials: 'excluded', runtime: { schemaVersion: version },
    }, null, 2), { mode: 0o600 });
    return { version, backupPath };
  } catch (error) {
    // A partial destination is not advertised as a usable migration backup.
    if (backupPath) rmSync(backupPath, { recursive: true, force: true });
    throw error;
  } finally { source.close(); }
}

export function registeredMediaHashes(db: DatabaseSync) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const hashes = new Set<string>();
  for (const table of ['artifact_drafts', 'artifact_revisions']) {
    if (!tables.has(table)) continue;
    for (const row of db.prepare(`SELECT body FROM ${table}`).all()) {
      const hash = JSON.parse(String(row.body)).sha256;
      if (hash) hashes.add(String(hash));
    }
  }
  if (tables.has('experience_media_links')) {
    for (const row of db.prepare('SELECT body FROM experience_media_links').all()) {
      const body = JSON.parse(String(row.body));
      if (body.sha256) hashes.add(String(body.sha256));
    }
  }
  if (tables.has('experience_exports')) for (const row of db.prepare('SELECT body FROM experience_exports').all()) {
    const body = JSON.parse(String(row.body));
    if (body.output?.sha256) hashes.add(String(body.output.sha256));
    for (const source of body.plan?.sources ?? []) if (source.sha256) hashes.add(String(source.sha256));
  }
  return hashes;
}
export function copyRegisteredArtifacts(db: DatabaseSync, source: string, target: string) {
  const hashes=registeredMediaHashes(db);
  mkdirSync(join(target, 'objects'), { recursive: true, mode: 0o700 });
  const files: { hash: string; bytes: number }[] = [];
  for (const hash of hashes) {
    ensure(/^[a-f0-9]{64}$/.test(hash), 'MEDIA_INVALID', '媒体哈希无效');
    const file = join(source, 'objects', hash);
    ensure(existsSync(file) && realpathSync(file).startsWith(resolve(source) + sep), 'MEDIA_INVALID', '备份媒体缺失');
    const bytes = readFileSync(file);
    ensure(createHash('sha256').update(bytes).digest('hex') === hash, 'MEDIA_INVALID', '备份媒体损坏');
    copyFileSync(file, join(target, 'objects', hash));
    files.push({ hash, bytes: bytes.length });
  }
  return files;
}

/** Called within the store's single migration transaction. Existing JSON is never rewritten. */
export function migrateStoreSchema(db: DatabaseSync, kinds: readonly Kind[]) {
  const version = databaseVersion(db);
  ensure(version >= 0 && version <= STORE_SCHEMA_VERSION, 'UNSUPPORTED', '数据版本高于当前应用，拒绝写入');
  db.exec(`CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,body TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,type TEXT NOT NULL,command_id TEXT NOT NULL,source TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS dependencies(project_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,owner_seq INTEGER NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,target_seq INTEGER NOT NULL,purpose TEXT NOT NULL,PRIMARY KEY(project_id,owner_kind,owner_id,owner_seq,target_kind,target_id,target_seq,purpose)) STRICT;`);
  for (const kind of kinds) db.exec(`CREATE TABLE IF NOT EXISTS ${kind}_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),body TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS ${kind}_project_idx ON ${kind}_drafts(project_id);
    CREATE TABLE IF NOT EXISTS ${kind}_revisions(id TEXT NOT NULL,project_id TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(id,seq)) STRICT;`);
  db.exec(`CREATE INDEX IF NOT EXISTS chapter_number_idx ON chapter_drafts(project_id,json_extract(body,'$.number'));
    CREATE INDEX IF NOT EXISTS scene_chapter_idx ON scene_drafts(project_id,json_extract(body,'$.chapterId'));
    CREATE INDEX IF NOT EXISTS shot_scene_idx ON shot_drafts(project_id,json_extract(body,'$.scene.id'));`);
  createExperienceSchema(db);
  if (version < 3) backfillLegacyReservations(db);
  db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
}

function createExperienceSchema(db: DatabaseSync) {
  for (const [collection, table] of Object.entries(experienceTables)) {
    const isRun = collection === 'runs';
    const shared = collection === 'releases' || collection === 'reservations';
    const generated = isRun ? ",release_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.releaseId')) STORED NOT NULL" : '';
    const extra = isRun
      ? ",CHECK(uid<>'' AND run_id=id), FOREIGN KEY(project_id,release_id) REFERENCES script_releases(project_id,id)"
      : shared ? '' : ",CHECK(uid<>'' AND run_id<>''), FOREIGN KEY(project_id,uid,run_id) REFERENCES experience_runs(project_id,uid,id)";
    db.exec(`CREATE TABLE IF NOT EXISTS ${table}(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, uid TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL CHECK(seq>0), body TEXT NOT NULL CHECK(json_valid(body) AND json_type(body)='object'),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL ${generated},
      UNIQUE(project_id,id), UNIQUE(project_id,uid,id), UNIQUE(project_id,uid,run_id,id) ${extra}
    ) STRICT;
    CREATE INDEX IF NOT EXISTS ${table}_scope_idx ON ${table}(project_id,uid,run_id);`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS script_release_manifest_idx ON script_releases(project_id,json_extract(body,'$.scriptRef.id'),json_extract(body,'$.scriptRef.seq'),json_extract(body,'$.manifestHash'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_visit_node_idx ON experience_visits(run_id,json_extract(body,'$.nodeId'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_activity_visit_idx ON experience_activities(run_id,json_extract(body,'$.visitId'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_instance_input_idx ON experience_instances(run_id,json_extract(body,'$.visitId'),json_extract(body,'$.inputHash'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_result_revision_idx ON experience_results(json_extract(body,'$.instanceId'),json_extract(body,'$.resultRevision'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_dispatch_request_idx ON experience_dispatches(json_extract(body,'$.requestId'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_dispatch_attempt_idx ON experience_dispatches(json_extract(body,'$.ownerKey'),json_extract(body,'$.stage'),json_extract(body,'$.attemptNo'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_effect_once_idx ON experience_effects(run_id,json_extract(body,'$.visitId'),json_extract(body,'$.phase'),json_extract(body,'$.effectId'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_position_visit_idx ON experience_positions(run_id,json_extract(body,'$.visitId'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_media_binding_idx ON experience_media_links(run_id,json_extract(body,'$.instanceId'),json_extract(body,'$.bindingId'));
    CREATE UNIQUE INDEX IF NOT EXISTS experience_export_request_idx ON experience_exports(project_id,uid,run_id,json_extract(body,'$.requestId'));
    CREATE UNIQUE INDEX IF NOT EXISTS generation_reservation_request_idx ON generation_reservations(json_extract(body,'$.requestId'));
    CREATE UNIQUE INDEX IF NOT EXISTS generation_reservation_attempt_idx ON generation_reservations(json_extract(body,'$.ownerKey'),json_extract(body,'$.stage'),json_extract(body,'$.attemptNo'));
    CREATE TABLE IF NOT EXISTS experience_receipts(project_id TEXT NOT NULL,uid TEXT NOT NULL CHECK(uid<>''),run_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,uid,run_id,request_id)) STRICT;
    CREATE TABLE IF NOT EXISTS experience_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,uid TEXT NOT NULL,run_id TEXT NOT NULL,type TEXT NOT NULL,command_id TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,FOREIGN KEY(project_id,uid,run_id) REFERENCES experience_runs(project_id,uid,id)) STRICT;
    CREATE INDEX IF NOT EXISTS experience_event_scope_idx ON experience_events(project_id,uid,run_id,cursor);
    CREATE TABLE IF NOT EXISTS generation_ledger_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;`);
}

function backfillLegacyReservations(db: DatabaseSync) {
  const now = new Date().toISOString();
  for (const row of db.prepare('SELECT id,project_id,body FROM job_drafts').all()) {
    const job = JSON.parse(String(row.body));
    if (!projectMediaProviders.has(job.intent?.provider)) continue;
    const body = { requestId: `legacy-job:${row.id}`, ownerKey: `author:job:${row.id}`, stage: 'media', attemptNo: 1,
      unit: 'media', countsProject: true, state: 'consumed', source: 'legacy', jobId: row.id, provider: job.intent.provider };
    db.prepare('INSERT OR IGNORE INTO generation_reservations(id,project_id,uid,run_id,seq,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(`legacy:${row.id}`, row.project_id, '', '', 1, stable(body), now, now);
  }
  db.prepare('INSERT OR IGNORE INTO generation_ledger_meta VALUES(?,?)').run('authority', 'legacy-job-count');
  db.prepare('INSERT OR IGNORE INTO generation_ledger_meta VALUES(?,?)').run('baseline', now);
}

/** Used only on copied backups: unknown external work must never be reissued. */
export function normalizeExperienceBackup(db: DatabaseSync) {
  if (databaseVersion(db) < 3) return;
  if(databaseVersion(db)>=4)for(const row of db.prepare('SELECT id,body FROM experience_exports').all()){
    const data=JSON.parse(String(row.body));if(!['queued','rendering'].includes(data.status))continue;
    data.status='failed';data.error='本地导出在备份时尚未完成，可按原清单明确重试';
    db.prepare('UPDATE experience_exports SET body=?,seq=seq+1,updated_at=? WHERE id=?').run(stable(data),new Date().toISOString(),row.id);
  }
  const recoveryReason = '从备份恢复，请核对原执行';
  for (const collection of ['runs', 'activities', 'instances', 'dispatches', 'reservations'] as const) {
    const table = experienceTables[collection];
    for (const row of db.prepare(`SELECT id,body FROM ${table}`).all()) {
      const data = JSON.parse(String(row.body));
      const field = typeof data.status === 'string' ? 'status' : 'state';
      const value = data[field];
      let next: string | undefined;
      if (collection === 'runs' && ['active', 'waitingInput', 'waitingContent'].includes(value)) next = 'blocked';
      if (collection === 'activities' && value === 'interpreting') next = 'failed';
      if (collection === 'instances' && ['planned', 'writing', 'checking', 'producing'].includes(value)) next = 'unknown';
      if (collection === 'dispatches' && ['planned', 'reserved', 'queued', 'running', 'dispatched', 'collecting'].includes(value)) next = 'unknown';
      if (collection === 'reservations' && ['reserved', 'dispatched'].includes(value)) next = 'unknown';
      if (!next) continue;
      data[field] = next;
      data.recoveryReason = recoveryReason;
      data.restoreBlocked = true;
      if (collection === 'runs' && Number.isSafeInteger(data.stateSeq)) data.stateSeq += 1;
      db.prepare(`UPDATE ${table} SET body=?,seq=seq+1,updated_at=? WHERE id=?`).run(stable(data), new Date().toISOString(), row.id);
    }
  }
}
