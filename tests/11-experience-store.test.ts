import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SqliteStore } from '../packages/infra/sqlite.ts';
import { ProjectData } from '../packages/contracts/foundation.ts';
import { JobData } from '../packages/contracts/production.ts';
import type { GenerationReservation } from '../packages/core/experience/ports.ts';

function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'dreamer-experience-store-'));
  const root = join(parent, 'data');
  const store = new SqliteStore(root), projectId = randomUUID();
  store.repository('project', ProjectData).create(projectId, ProjectData.parse({ title: '私有路线' }), projectId);
  const release = store.experience.create('releases', { projectId }, { scriptRef: { id: randomUUID(), seq: 1 }, manifestHash: 'fixed', kind: 'simulation' });
  const run = store.experience.create('runs', { projectId, uid: 'reader-a' }, { releaseId: release.id, status: 'active', stateSeq: 1 });
  const scope = { projectId, uid: 'reader-a', runId: run.id };
  const visit = store.experience.create('visits', scope, { nodeId: 'opening', status: 'entered' });
  return { parent, root, store, projectId, release, run, scope, visit, close() { store.close(); rmSync(parent, { recursive: true, force: true }); } };
}

for (const version of [0, 1, 2]) test(`11 schema ${version} → 4 先备份，原 JSON、修订与预算基线保持且重开不重复`, () => {
  const parent = mkdtempSync(join(tmpdir(), 'dreamer-migration-')), root = join(parent, 'data');
  mkdirSync(root);
  const projectId = randomUUID(), db = new DatabaseSync(join(root, 'dreamer.sqlite'));
  const projectBody = JSON.stringify(ProjectData.parse({ title: '旧工程' }), null, 2);
  const jobBody = JSON.stringify({ intent: { provider: 'h3' }, state: 'queued' });
  db.exec(`CREATE TABLE project_drafts(id TEXT PRIMARY KEY,project_id TEXT,seq INTEGER,body TEXT,updated_at TEXT);
    CREATE TABLE project_revisions(id TEXT,project_id TEXT,seq INTEGER,body TEXT,updated_at TEXT,PRIMARY KEY(id,seq));
    CREATE TABLE job_drafts(id TEXT PRIMARY KEY,project_id TEXT,seq INTEGER,body TEXT,updated_at TEXT);
    PRAGMA user_version=${version};`);
  db.prepare('INSERT INTO project_drafts VALUES(?,?,?,?,?)').run(projectId, projectId, 7, projectBody, 'old');
  db.prepare('INSERT INTO project_revisions VALUES(?,?,?,?,?)').run(projectId, projectId, 7, projectBody, 'old');
  db.prepare('INSERT INTO job_drafts VALUES(?,?,?,?,?)').run('old-job', projectId, 3, jobBody, 'old');
  db.close();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    assert.equal(store.health().schemaVersion, 4);
    assert.ok(store.migrationBackupPath);
    const backup = new DatabaseSync(join(store.migrationBackupPath!, 'dreamer.sqlite'), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, version);
    assert.equal(backup.prepare('SELECT body FROM project_revisions').get()!.body, projectBody);
    backup.close();
    assert.deepEqual(store.experience.usage({ projectId }), { projectMedia: 1, runMedia: 0, runText: 0 });
    store.close(); store = undefined;
    const check = new DatabaseSync(join(root, 'dreamer.sqlite'), { readOnly: true });
    assert.equal(check.prepare('SELECT body FROM project_revisions').get()!.body, projectBody);
    assert.equal(check.prepare('SELECT body FROM job_drafts').get()!.body, jobBody);
    assert.equal(check.prepare('SELECT seq FROM project_drafts').get()!.seq, 7);
    check.close();
    store = new SqliteStore(root);
    assert.equal(store.migrationBackupPath, undefined);
    assert.equal(store.experience.usage({ projectId }).projectMedia, 1);
    assert.equal(readdirSync(parent).filter(name => name.startsWith('.dreamer-before-schema4-')).length, 1);
  } finally { store?.close(); rmSync(parent, { recursive: true, force: true }); }
});

test('11 未支持的版本与备份失败不触碰源库；迁移失败回滚新表和版本', () => {
  for (const failure of ['future', 'missing-artifact', 'bad-job'] as const) {
    const parent = mkdtempSync(join(tmpdir(), 'dreamer-migration-fail-')), root = join(parent, 'data');
    mkdirSync(root);
    const path = join(root, 'dreamer.sqlite'), db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version=${failure === 'future' ? 99 : 2}`);
    if (failure === 'missing-artifact') {
      db.exec('CREATE TABLE artifact_drafts(body TEXT)');
      db.prepare('INSERT INTO artifact_drafts VALUES(?)').run(JSON.stringify({ sha256: 'a'.repeat(64) }));
    }
    if (failure === 'bad-job') {
      db.exec('CREATE TABLE job_drafts(id TEXT,project_id TEXT,body TEXT)');
      db.prepare('INSERT INTO job_drafts VALUES(?,?,?)').run('bad', 'old', '{invalid');
    }
    db.close();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    try {
      assert.throws(() => new SqliteStore(root), failure === 'future' ? /数据版本/ : failure === 'missing-artifact' ? /备份媒体缺失/ : /JSON/);
      const after = new DatabaseSync(path, { readOnly: true });
      assert.equal(after.prepare('PRAGMA user_version').get()!.user_version, failure === 'future' ? 99 : 2);
      assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name='experience_runs'").get(), undefined);
      after.close();
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }
});

test('11 私有记录逐层核对 project/uid/run，固定结果不可改，唯一效果与实例不可重复', () => {
  const x = setup();
  try {
    assert.throws(() => x.store.experience.get('runs', x.run.id, { projectId: x.projectId, uid: 'reader-b' }), /当前范围/);
    assert.throws(() => x.store.experience.list('visits', { ...x.scope, uid: 'reader-b' }), /当前用户/);
    assert.throws(() => x.store.experience.list('visits', { projectId: x.projectId }), /uid 和 runId/);
    assert.throws(() => x.store.experience.save('releases', x.release.id, { projectId: x.projectId }, 1, x.release.data), /不可修改/);
    assert.throws(() => x.store.experience.create('visits', x.scope, { nodeId: 'opening' }), /重复/);
    const instance = x.store.experience.create('instances', x.scope, { visitId: x.visit.id, inputHash: 'input', status: 'planned' });
    assert.throws(() => x.store.experience.create('instances', x.scope, { visitId: x.visit.id, inputHash: 'input' }), /重复/);
    const result = x.store.experience.create('results', x.scope, { instanceId: instance.id, resultRevision: 1, text: '过去已发生的内容' });
    assert.throws(() => x.store.experience.save('results', result.id, x.scope, result.seq, result.data), /不可修改/);
    const effect = { visitId: x.visit.id, phase: 'checkpointReached', effectId: 'trust+1' };
    x.store.experience.create('effects', x.scope, effect);
    assert.throws(() => x.store.experience.create('effects', x.scope, effect), /重复/);
    assert.deepEqual(x.store.events(x.projectId, 0), []);
  } finally { x.close(); }
});

test('11 运行、输入、回执、事件和预算在单事务原子提交，旧回执先于新状态可读', () => {
  const x = setup(), input = { expectedStateSeq: 1, selected: 'left' }, requestId = randomUUID();
  const reservation: GenerationReservation = { requestId: 'text-1', ownerKey: `run:${x.run.id}`, stage: 'write', attemptNo: 1, unit: 'text', countsProject: false, state: 'reserved', source: 'runtime' };
  try {
    assert.throws(() => x.store.transaction(() => {
      x.store.experience.save('runs', x.run.id, x.scope, 1, { ...x.run.data, stateSeq: 2 });
      x.store.experience.create('activities', x.scope, { visitId: x.visit.id, status: 'completed', result: 'left' });
      x.store.experience.saveReceipt(x.scope, requestId, input, { stateSeq: 2 });
      x.store.experience.append(x.scope, 'activity.completed', { choice: 'left' }, requestId);
      x.store.experience.reserve(x.scope, reservation, { projectMedia: 3, runText: 1 });
      throw new Error('before-commit');
    }), /before-commit/);
    assert.equal(x.store.experience.get('runs', x.run.id, x.scope).seq, 1);
    assert.equal(x.store.experience.list('activities', x.scope).length, 0);
    assert.equal(x.store.experience.receipt(x.scope, requestId, input), undefined);
    assert.equal(x.store.experience.events(x.scope, 0).length, 0);
    assert.equal(x.store.experience.usage(x.scope).runText, 0);
    x.store.transaction(() => {
      x.store.experience.save('runs', x.run.id, x.scope, 1, { ...x.run.data, stateSeq: 2 });
      x.store.experience.saveReceipt(x.scope, requestId, input, { stateSeq: 2 });
    });
    assert.deepEqual(x.store.experience.receipt(x.scope, requestId, input), { stateSeq: 2 });
    assert.throws(() => x.store.experience.receipt(x.scope, requestId, { ...input, selected: 'right' }), /请求标识/);
    assert.throws(() => x.store.transaction(() => x.store.experience.transaction(() => undefined)), /嵌套/);
  } finally { x.close(); }
});

test('11 预约竞争不超预算，只有从未派发的预约允许释放', () => {
  const x = setup();
  const data: GenerationReservation = { requestId: 'media-1', ownerKey: `run:${x.run.id}`, stage: 'media', attemptNo: 1, unit: 'media', countsProject: true, state: 'reserved', source: 'runtime' };
  try {
    assert.throws(() => x.store.experience.reserve(x.scope, data, { projectMedia: 1, runMedia: 1 }), /外层事务/);
    const reservation = x.store.transaction(() => x.store.experience.reserve(x.scope, data, { projectMedia: 1, runMedia: 1 }));
    assert.throws(() => x.store.transaction(() => x.store.experience.reserve(x.scope, { ...data, requestId: 'media-2', attemptNo: 2 }, { projectMedia: 1, runMedia: 1 })), /预算/);
    const dispatched = x.store.experience.save('reservations', reservation.id, x.scope, 1, { ...data, state: 'dispatched' });
    assert.throws(() => x.store.experience.save('reservations', reservation.id, x.scope, dispatched.seq, { ...data, state: 'released' }), /不可退还/);
    assert.equal(x.store.experience.usage(x.scope).projectMedia, 1);
  } finally { x.close(); }
});

test('11 备份包含私有媒体并挂起未完成运行与派发，源库保持原状', async () => {
  const x = setup();
  try {
    const instance = x.store.experience.create('instances', x.scope, { visitId: x.visit.id, inputHash: 'input', status: 'producing' });
    const dispatch = x.store.experience.create('dispatches', x.scope, { requestId: 'external-1', ownerKey: instance.id, stage: 'media', attemptNo: 1, state: 'queued' });
    const bytes = Buffer.from('private immutable media'), sha256 = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(x.root, 'objects'), { recursive: true }); writeFileSync(join(x.root, 'objects', sha256), bytes);
    x.store.experience.create('mediaLinks', x.scope, { instanceId: instance.id, bindingId: 'video', sha256 });
    const destination = join(x.parent, 'backup');
    await x.store.backup(destination);
    const restored = new SqliteStore(destination);
    try {
      assert.equal(restored.experience.get('runs', x.run.id, x.scope).data.status, 'blocked');
      assert.equal(restored.experience.get('instances', instance.id, x.scope).data.status, 'unknown');
      assert.equal(restored.experience.get('dispatches', dispatch.id, x.scope).data.state, 'unknown');
      assert.equal(restored.experience.get('dispatches', dispatch.id, x.scope).data.requestId, 'external-1');
      assert.deepEqual(readFileSync(join(destination, 'objects', sha256)), bytes);
      assert.equal(restored.experience.list('mediaLinks', x.scope).length, 1);
    } finally { restored.close(); }
    assert.equal(x.store.experience.get('runs', x.run.id, x.scope).data.status, 'active');
    assert.equal(x.store.experience.get('dispatches', dispatch.id, x.scope).data.state, 'queued');
  } finally { x.close(); }
});

test('11 旧 Job 解码默认 author，体验所有者不接受缺失归属', () => {
  const old = { title: '旧任务', intent: { provider: 'placeholder', profile: 'v1', prompt: '', constraints: {} }, fingerprint: 'fixed', state: 'queued', attempts: [], submittedAt: 'then' };
  assert.deepEqual(JobData.parse(old).owner, { type: 'author' });
  assert.equal(Object.hasOwn(old, 'owner'), false);
  assert.equal(JobData.safeParse({ ...old, owner: { type: 'experience', runId: randomUUID() } }).success, false);
});
