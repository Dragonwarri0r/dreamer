import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Id, ensure, parse, stable } from '../contracts/foundation.ts';
import { CloudVideoId, isCloudVideo, wanRegions } from '../contracts/cloud-video.ts';
import { normalizeExperienceBackup, STORE_SCHEMA_VERSION, registeredMediaHashes } from './store-migrations.ts';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const BackupFile = z.strictObject({ hash: Hash, bytes: z.number().int().positive().safe() });
export const CloudRecovery = z.strictObject({
  provider: CloudVideoId, requestId: Id, fingerprint: Hash,
  endpoint: z.string().max(300).optional(), model: z.string().regex(/^[\w./-]{1,120}$/).optional(),
  remoteId: z.string().regex(/^[\w-]{1,200}$/).optional(),
  state: z.enum(['unknown', 'completed', 'failed', 'cancelled']), cancelRequested: z.boolean().default(false),
  outputHash: Hash.optional(), nativeAudioHash: Hash.optional(),
}).superRefine((value, ctx) => {
  if (!!value.endpoint !== !!value.model) ctx.addIssue({ code: 'custom', message: '恢复配置的 endpoint/model 必须同时存在' });
  if (value.remoteId && !value.endpoint) ctx.addIssue({ code: 'custom', message: '远端任务需要原配置' });
  if (value.state === 'completed' && !value.outputHash) ctx.addIssue({ code: 'custom', message: '完成恢复记录需要固定输出' });
  if (value.endpoint) {
    const valid = value.provider === 'seedance' ? value.endpoint === 'https://ark.cn-beijing.volces.com/api/v3' : value.provider === 'fal-h3' ? value.endpoint === 'https://queue.fal.run' : wanRegions.some(region => new RegExp(`^https://[a-zA-Z0-9-]+\\.${region.replaceAll('.', '\\.')}\\.maas\\.aliyuncs\\.com/api/v1$`).test(value.endpoint!));
    if (!valid) ctx.addIssue({ code: 'custom', message: '恢复地址必须是原 Provider 无凭据的固定端点' });
  }
});
export type CloudRecovery = z.infer<typeof CloudRecovery>;
const TextRemote = z.strictObject({ threadId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(), turnId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional() });
export const TextRecovery = z.strictObject({
  requestId: Id, inputHash: Hash, configurationHash: Hash,
  state: z.enum(['started', 'completed', 'cancelled']), remote: TextRemote.optional(), result: z.json().optional(),
}).superRefine((value, ctx) => { if (value.state === 'completed' && value.result === undefined) ctx.addIssue({ code: 'custom', message: '完成的文本恢复需要原结构化结果' }); });
export type TextRecovery = z.infer<typeof TextRecovery>;

const commonManifest = { createdAt: z.string().datetime(), files: z.array(BackupFile), credentials: z.literal('excluded'), runtime: z.strictObject({ schemaVersion: z.number().int().min(0).max(STORE_SCHEMA_VERSION), sqlite: z.string().optional(), journalMode: z.string().optional() }) };
export const BackupManifest = z.discriminatedUnion('version', [
  z.strictObject({ version: z.literal(1), ...commonManifest, purpose: z.literal('before-schema-migration').optional() }),
  z.strictObject({ version: z.literal(2), ...commonManifest, databaseSha256: Hash, cloudRecovery: z.array(CloudRecovery), textRecovery: z.array(TextRecovery).default([]) }),
]);
export type BackupManifest = z.infer<typeof BackupManifest>;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function localFile(root: string, file: string, label: string): string {
  ensure(existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && realpathSync(file).startsWith(realpathSync(root) + sep), 'MEDIA_INVALID', `${label} 缺失、为链接或超出目录`);
  return file;
}
function copyOutput(root: string, target: string, path: unknown, expectedHash: unknown, files: Map<string, { hash: string; bytes: number }>): string | undefined {
  if (typeof path !== 'string' || typeof expectedHash !== 'string' || !Hash.safeParse(expectedHash).success || !existsSync(path)) return;
  localFile(root, path, '云端本机结果');
  const bytes = readFileSync(path); ensure(digest(bytes) === expectedHash && bytes.length > 0, 'MEDIA_INVALID', '云端本机结果哈希损坏');
  if (!files.has(expectedHash)) { mkdirSync(join(target, 'objects'), { recursive: true, mode: 0o700 }); copyFileSync(path, join(target, 'objects', expectedHash)); files.set(expectedHash, { hash: expectedHash, bytes: bytes.length }); }
  return expectedHash;
}
/** Reads only journals referenced by the database snapshot; credentials and opaque provider text are never copied. */
export function collectCloudRecovery(db: DatabaseSync, root: string, target: string, existingFiles: { hash: string; bytes: number }[]) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const references = new Map<string, { provider: CloudRecovery['provider']; requestId: string; fingerprint: string }>();
  for (const table of ['job_revisions', 'job_drafts']) {
    if (!tables.has(table)) continue;
    for (const row of db.prepare(`SELECT body FROM ${table}`).all()) {
      const data = JSON.parse(String(row.body)); if (!isCloudVideo(data.intent?.provider)) continue;
      for (const attempt of data.attempts ?? []) {
        parse(Id, attempt.requestId); parse(Hash, data.fingerprint);
        references.set(`${data.intent.provider}:${attempt.requestId}`, { provider: data.intent.provider, requestId: attempt.requestId, fingerprint: data.fingerprint });
      }
    }
  }
  const files = new Map(existingFiles.map(file => [file.hash, file])), descriptions: CloudRecovery[] = [];
  for (const reference of references.values()) {
    const path = join(root, 'runtime', 'cloud-video', reference.provider, reference.requestId, 'state.json');
    if (!existsSync(path)) { descriptions.push({ ...reference, state: 'unknown', cancelRequested: false }); continue; }
    localFile(root, path, '云任务恢复描述'); const journal = JSON.parse(readFileSync(path, 'utf8'));
    const outputHash = journal.receipt?.state === 'completed' ? copyOutput(root, target, journal.receipt.path, journal.receipt.sha256, files) : undefined;
    const nativeAudioHash = outputHash && journal.receipt?.nativeAudio ? copyOutput(root, target, journal.receipt.nativeAudio.path, journal.receipt.nativeAudio.sha256, files) : undefined;
    const state = journal.receipt?.state === 'completed' && outputHash && (!journal.receipt.nativeAudio || nativeAudioHash) ? 'completed' : ['failed', 'cancelled'].includes(journal.receipt?.state) ? journal.receipt.state : 'unknown';
    descriptions.push(parse(CloudRecovery, { ...reference, endpoint: journal.endpoint, model: journal.model, remoteId: journal.remoteId, state, cancelRequested: journal.cancelRequested === true, ...(state === 'completed' ? { outputHash, nativeAudioHash } : {}) }));
  }
  return { cloudRecovery: descriptions, files: [...files.values()] };
}
function textDispatchRequests(db: DatabaseSync): Map<string, { requestId: string; inputHash: string; configurationHash: string; remote?: z.infer<typeof TextRemote> }> {
  const requests = new Map<string, { requestId: string; inputHash: string; configurationHash: string; remote?: z.infer<typeof TextRemote> }>();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='experience_dispatches'").get()) return requests;
  for (const row of db.prepare('SELECT body FROM experience_dispatches').all()) {
    const dispatch = JSON.parse(String(row.body));
    if (!['interpret', 'write', 'check', 'repair'].includes(dispatch.stage) || !dispatch.request) continue;
    const request = dispatch.request;
    ensure(request.requestId === dispatch.requestId && request.inputHash === dispatch.inputHash, 'VALIDATION', '文本派发身份与冻结请求不一致');
    requests.set(parse(Id, request.requestId), { requestId: request.requestId, inputHash: parse(Hash, request.inputHash), configurationHash: parse(Hash, request.configurationHash), ...(request.remote ? { remote: parse(TextRemote, request.remote) } : {}) });
  }
  return requests;
}
/** Retains a result that landed on disk before its DB commit, with identity verified against the frozen dispatch. */
export function collectTextRecovery(db: DatabaseSync, root: string): TextRecovery[] {
  const entries: TextRecovery[] = [];
  for (const request of textDispatchRequests(db).values()) {
    const path = join(root, 'runtime', 'experience-text', `${request.requestId}.json`);
    if (!existsSync(path)) { entries.push({ ...request, state: 'started' }); continue; }
    const raw = JSON.parse(readFileSync(localFile(root, path, '文本恢复描述'), 'utf8'));
    ensure(raw.requestId === request.requestId && raw.inputHash === request.inputHash && raw.configurationHash === request.configurationHash, 'VALIDATION', '文本恢复描述与冻结派发不匹配');
    // Whitelist only execution identity and the returned structured result. No input/config/environment paths.
    entries.push(parse(TextRecovery, { ...request, state: raw.state, remote: raw.remote ?? request.remote, ...(raw.result === undefined ? {} : { result: raw.result }) }));
  }
  return entries;
}
/** Normalize destination/snapshot only. No providers, App Server, Application, or networking is constructed. */
export function suspendBackupExecution(db: DatabaseSync) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  for (const kind of ['job', 'thread'] as const) {
    if (!tables.has(`${kind}_drafts`)) continue;
    for (const row of db.prepare(`SELECT id,body FROM ${kind}_drafts`).all()) {
      const data = JSON.parse(String(row.body));
      if (!['queued', 'running', 'recovering', 'collecting'].includes(data.state)) continue;
      data.state = kind === 'job' ? 'unknown' : 'interrupted'; data.recoveryReason = '从备份恢复，请核对原执行';
      if (kind === 'job' && Array.isArray(data.attempts)) data.attempts = data.attempts.map((attempt: any) => ['queued', 'running'].includes(attempt.state) ? { ...attempt, state: 'unknown' } : attempt);
      db.prepare(`UPDATE ${kind}_drafts SET body=?,seq=seq+1 WHERE id=?`).run(stable(data), row.id);
    }
  }
  normalizeExperienceBackup(db);
}
export function restoreBackup(sourceArg: string, destinationArg: string) {
  const source = realpathSync(resolve(sourceArg)), destination = resolve(destinationArg);
  ensure(!existsSync(destination), 'VALIDATION', '恢复目标必须是新目录，禁止覆盖');
  const manifest = parse(BackupManifest, JSON.parse(readFileSync(localFile(source, join(source, 'backup.json'), '备份清单'), 'utf8')));
  const hashes = new Set<string>();
  for (const file of manifest.files) {
    ensure(!hashes.has(file.hash), 'VALIDATION', '备份素材标识重复'); hashes.add(file.hash);
    const path = localFile(source, join(source, 'objects', file.hash), '备份媒体'), bytes = readFileSync(path);
    ensure(bytes.length === file.bytes && digest(bytes) === file.hash, 'MEDIA_INVALID', '备份媒体哈希校验失败');
  }
  const database = localFile(source, join(source, 'dreamer.sqlite'), '备份数据库');
  if (manifest.version === 2) {
    ensure(digest(readFileSync(database)) === manifest.databaseSha256, 'VALIDATION', '备份数据库哈希校验失败');
    const identities = new Set<string>();
    for (const entry of manifest.cloudRecovery) {
      const identity = `${entry.provider}:${entry.requestId}`; ensure(!identities.has(identity), 'VALIDATION', '恢复任务身份重复'); identities.add(identity);
      ensure(!entry.outputHash || hashes.has(entry.outputHash), 'MEDIA_INVALID', '恢复任务输出未收入备份');
      ensure(!entry.nativeAudioHash || hashes.has(entry.nativeAudioHash), 'MEDIA_INVALID', '恢复原声未收入备份');
    }
  }
  const check = new DatabaseSync(database, { readOnly: true }); let projects = 0;
  try {
    ensure(check.prepare('PRAGMA integrity_check').get()!.integrity_check === 'ok', 'VALIDATION', '备份数据库完整性检查失败');
    const version = Number(check.prepare('PRAGMA user_version').get()!.user_version);
    ensure(version === manifest.runtime.schemaVersion && version <= STORE_SCHEMA_VERSION, 'UNSUPPORTED', '备份数据库版本与清单不一致');
    for(const hash of registeredMediaHashes(check))ensure(hashes.has(hash),'MEDIA_INVALID','备份清单缺少已登记的原素材或私有导出视频');
    const hasProjects = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_drafts'").get();
    projects = hasProjects ? Number(check.prepare('SELECT count(*) AS count FROM project_drafts').get()!.count) : 0;
    if (manifest.version === 2) {
      const requests = textDispatchRequests(check), known = new Set<string>();
      for (const entry of manifest.textRecovery) {
        const request = requests.get(entry.requestId);
        ensure(!known.has(entry.requestId) && request && request.inputHash === entry.inputHash && request.configurationHash === entry.configurationHash, 'VALIDATION', '文本恢复身份不属于备份中的冻结派发');
        known.add(entry.requestId);
        if (request.remote?.threadId) ensure(entry.remote?.threadId === request.remote.threadId, 'VALIDATION', '文本恢复不能改换已知会话');
        if (request.remote?.turnId) ensure(entry.remote?.turnId === request.remote.turnId, 'VALIDATION', '文本恢复不能改换已知轮次');
      }
    }

  } finally { check.close(); }
  try {
    mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, 'objects'), { mode: 0o700 });
    copyFileSync(database, join(destination, 'dreamer.sqlite'));
    for (const file of manifest.files) copyFileSync(join(source, 'objects', file.hash), join(destination, 'objects', file.hash));
    // New paths are computed from validated identities; no original machine path is accepted.
    if (manifest.version === 2) for (const entry of manifest.cloudRecovery) {
      if (!entry.endpoint || !entry.model) continue;
      const directory = join(destination, 'runtime', 'cloud-video', entry.provider, entry.requestId); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const receipt = entry.state === 'completed' ? { state: 'completed', path: join(destination, 'objects', entry.outputHash!), sha256: entry.outputHash, ...(entry.nativeAudioHash ? { nativeAudio: { path: join(destination, 'objects', entry.nativeAudioHash), sha256: entry.nativeAudioHash } } : {}) } : { state: entry.state, error: '从备份恢复，仅核对原任务；请配置原凭据，不会重新提交' };
      writeFileSync(join(directory, 'state.json'), JSON.stringify({ endpoint: entry.endpoint, model: entry.model, remoteId: entry.remoteId, receipt, nextPoll: 0, cancelRequested: entry.cancelRequested }), { mode: 0o600 });
    }
    if (manifest.version === 2 && manifest.textRecovery.length) {
      const directory = join(destination, 'runtime', 'experience-text'); mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const entry of manifest.textRecovery) writeFileSync(join(directory, `${entry.requestId}.json`), JSON.stringify(entry), { mode: 0o600 });
    }
    const restored = new DatabaseSync(join(destination, 'dreamer.sqlite'));
    try { restored.exec('BEGIN IMMEDIATE'); suspendBackupExecution(restored); restored.exec('COMMIT'); }
    catch (error) { restored.exec('ROLLBACK'); throw error; }
    finally { restored.close(); }
    writeFileSync(join(destination, 'backup.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { restoredTo: destination, projects, artifacts: manifest.files.length, cloudTasks: manifest.version === 2 ? manifest.cloudRecovery.length : 0, textTasks: manifest.version === 2 ? manifest.textRecovery.length : 0, externalRequestsResubmitted: false, externalRequests: 0 };
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}
