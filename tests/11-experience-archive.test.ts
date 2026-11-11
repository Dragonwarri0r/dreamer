import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { SqliteStore } from '../packages/infra/sqlite.ts';
import { ProjectData } from '../packages/contracts/foundation.ts';
import { JobData } from '../packages/contracts/production.ts';
import { CloudVideoProvider } from '../packages/infra/cloud-video.ts';
import { CloudVideoSettings } from '../packages/infra/cloud-video-settings.ts';
import { restoreBackup } from '../packages/infra/recovery.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'dreamer-private-archive-')), root = join(parent, 'source'), store = new SqliteStore(root), pid = randomUUID();
  store.repository('project', ProjectData).create(pid, ProjectData.parse({ title: '恢复任务' }), pid);
  const jobs = store.repository('job', JobData);
  function job(state: 'running' | 'collecting' | 'queued', remoteId?: string, completed = false) {
    const requestId = randomUUID(), path = join(root, 'runtime', 'cloud-video', 'wan', requestId); mkdirSync(path, { recursive: true });
    const video = Buffer.from('original downloaded video'), audio = Buffer.from('original native audio');
    if (completed) { writeFileSync(join(path, 'video.mp4'), video); writeFileSync(join(path, 'native.wav'), audio); }
    writeFileSync(join(path, 'state.json'), JSON.stringify({ endpoint: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1', model: 'wan3.0-video', remoteId, nextPoll: 123, apiKey: 'DO-NOT-BACK-UP-KEY', signedUrl: 'https://download.example/video?secret=NO', receipt: completed ? { state: 'completed', path: join(path, 'video.mp4'), sha256: sha(video), nativeAudio: { path: join(path, 'native.wav'), sha256: sha(audio) }, metrics: { upstreamKey: 'DO-NOT-BACK-UP-KEY' } } : { state: 'running', error: 'DO-NOT-BACK-UP-KEY https://signed?secret=NO' } }));
    const row = jobs.create(pid, JobData.parse({ title: '云任务', intent: { provider: 'wan', profile: '720p', prompt: '测试', constraints: {}, quality: 'final' }, fingerprint: 'a'.repeat(64), state, attempts: [{ id: randomUUID(), requestId, lease: randomUUID(), state: state === 'queued' ? 'queued' : 'running' }], submittedAt: new Date().toISOString() }));
    return { id: row.id, requestId, outputHash: sha(video), audioHash: sha(audio) };
  }
  return { parent, root, store, pid, jobs, job, close() { store.close(); rmSync(parent, { recursive: true, force: true }); } };
}

test('11 S5 backup v2 retains cloud identity and completed local audio/video without credentials/old paths; restore does zero external calls', async () => {
  const x = setup();
  try {
    const active = x.job('running', 'original-task-1'), lost = x.job('queued'), collecting = x.job('collecting', 'original-task-2', true);
    const sourceBodies = x.jobs.list(x.pid).map(row => JSON.stringify(row)), backup = join(x.parent, 'backup'), target = join(x.parent, 'restored');
    await x.store.backup(backup);
    const manifestText = readFileSync(join(backup, 'backup.json'), 'utf8'), manifest = JSON.parse(manifestText);
    assert.equal(manifest.version, 2); assert.equal(manifest.cloudRecovery.length, 3);
    assert.equal(manifest.cloudRecovery.find((item: any) => item.requestId === active.requestId).remoteId, 'original-task-1');
    assert.equal(manifest.cloudRecovery.find((item: any) => item.requestId === lost.requestId).remoteId, undefined);
    assert.equal(manifest.cloudRecovery.find((item: any) => item.requestId === lost.requestId).state, 'unknown');
    assert.equal(manifest.files.length, 2); assert.ok(!manifestText.includes('DO-NOT-BACK-UP-KEY')); assert.ok(!manifestText.includes('signedUrl')); assert.ok(!manifestText.includes(x.root));
    const originalFetch = globalThis.fetch; let external = 0;
    globalThis.fetch = async () => { external++; throw new Error('network forbidden'); };
    try { const result = restoreBackup(backup, target); assert.equal(result.externalRequests, 0); assert.equal(result.cloudTasks, 3); assert.equal(external, 0); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(existsSync(join(target, 'credentials')), false);
    const db = new DatabaseSync(join(target, 'dreamer.sqlite'), { readOnly: true });
    try { for (const row of db.prepare('SELECT body FROM job_drafts').all()) assert.equal(JSON.parse(String(row.body)).state, 'unknown'); } finally { db.close(); }
    assert.deepEqual(x.jobs.list(x.pid).map(row => JSON.stringify(row)), sourceBodies);
    const outputJournal = JSON.parse(readFileSync(join(target, 'runtime', 'cloud-video', 'wan', collecting.requestId, 'state.json'), 'utf8'));
    assert.equal(outputJournal.receipt.path, join(target, 'objects', collecting.outputHash));
    assert.equal(outputJournal.receipt.nativeAudio.path, join(target, 'objects', collecting.audioHash));
    const settings = new CloudVideoSettings(target); let requests = 0;
    const provider = new CloudVideoProvider('wan', settings, target, async () => { requests++; return new Response('{}'); });
    assert.equal((await provider.status(collecting.requestId)).state, 'completed'); assert.equal(requests, 0);
    assert.equal((await provider.status(active.requestId)).state, 'unknown'); assert.equal(requests, 0);
    assert.equal((await provider.status(lost.requestId)).state, 'unknown'); assert.equal(requests, 0);
  } finally { x.close(); }
});
test('11 S5 restore CLI reads old v1 without Application/Provider startup and preserves source backup bytes', async () => {
  const x = setup();
  try {
    x.job('running', 'task-v1'); const backup = join(x.parent, 'backup'), target = join(x.parent, 'v1-restored'); await x.store.backup(backup);
    const manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8')); delete manifest.databaseSha256; delete manifest.cloudRecovery; delete manifest.textRecovery; manifest.version = 1;
    writeFileSync(join(backup, 'backup.json'), JSON.stringify(manifest));
    const before = sha(readFileSync(join(backup, 'dreamer.sqlite')));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/restore.ts', backup, target], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DREAMER_CODEX_BIN: '/not-a-binary', DREAMER_H3_URL: 'http://127.0.0.1:1' } });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).externalRequests, 0);
    assert.equal(sha(readFileSync(join(backup, 'dreamer.sqlite'))), before);
    assert.equal(existsSync(join(target, 'runtime', 'agent-config')), false);
    assert.equal(existsSync(join(target, 'credentials')), false);
  } finally { x.close(); }
});
test('11 S5 restore rejects forged recovery path, credential field, endpoint, DB hash and linked media before creating destination', async () => {
  const x = setup();
  try {
    x.job('collecting', 'task-safe', true); const backup = join(x.parent, 'backup'); await x.store.backup(backup);
    const original = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'));
    for (const tamper of [
      (manifest: any) => { manifest.cloudRecovery[0].requestId = '../../escape'; },
      (manifest: any) => { manifest.cloudRecovery[0].apiKey = 'secret'; },
      (manifest: any) => { manifest.cloudRecovery[0].endpoint = 'https://attacker.example?apiKey=secret'; },
      (manifest: any) => { manifest.databaseSha256 = '0'.repeat(64); },
      (manifest: any) => { manifest.cloudRecovery[0].outputHash = '0'.repeat(64); },
    ]) {
      const manifest = structuredClone(original); tamper(manifest); writeFileSync(join(backup, 'backup.json'), JSON.stringify(manifest));
      const target = join(x.parent, randomUUID()); assert.throws(() => restoreBackup(backup, target)); assert.equal(existsSync(target), false);
    }
    writeFileSync(join(backup, 'backup.json'), JSON.stringify(original));
    const media = join(backup, 'objects', original.files[0].hash), outside = join(x.parent, 'outside');
    writeFileSync(outside, readFileSync(media)); rmSync(media); symlinkSync(outside, media);
    const target = join(x.parent, 'linked'); assert.throws(() => restoreBackup(backup, target), /链接|超出/); assert.equal(existsSync(target), false);
  } finally { x.close(); }
});

test('11 S5 text result landed before DB commit survives backup; restore verifies frozen dispatch identity and adapter reads it without new model call', async () => {
  const x = setup();
  try {
    const release = x.store.experience.create('releases', { projectId: x.pid }, { scriptRef: { id: randomUUID(), seq: 1 }, manifestHash: 'fixed' });
    const run = x.store.experience.create('runs', { projectId: x.pid, uid: 'reader' }, { releaseId: release.id, status: 'waitingContent', stateSeq: 1 });
    const scope = { projectId: x.pid, uid: 'reader', runId: run.id }, visit = x.store.experience.create('visits', scope, { nodeId: randomUUID(), status: 'active' });
    const instance = x.store.experience.create('instances', scope, { visitId: visit.id, inputHash: 'd'.repeat(64), status: 'writing' });
    const requestId = randomUUID(), inputHash = 'e'.repeat(64), configurationHash = 'f'.repeat(64);
    x.store.experience.create('dispatches', scope, { requestId, ownerKey: `instance:${instance.id}`, owner: { type: 'segmentInstance', instanceId: instance.id }, stage: 'write', attemptNo: 1, state: 'dispatched', inputHash, request: { requestId, stage: 'write', inputHash, configurationHash, input: {}, outputSchema: {} } });
    const directory = join(x.root, 'runtime', 'experience-text'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${requestId}.json`), JSON.stringify({ requestId, inputHash, configurationHash, state: 'completed', remote: { threadId: 'original-thread', turnId: 'original-turn' }, result: { text: '仅此一次生成的原文' }, apiKey: 'DO-NOT-EXPORT', outputPath: '/old/computer/private-file' }));
    const backup = join(x.parent, 'text-backup'), destination = join(x.parent, 'text-restored'); await x.store.backup(backup);
    const text = readFileSync(join(backup, 'backup.json'), 'utf8'), manifest = JSON.parse(text);
    assert.equal(manifest.textRecovery.length, 1); assert.ok(!text.includes('DO-NOT-EXPORT')); assert.ok(!text.includes('/old/computer'));
    assert.equal(restoreBackup(backup, destination).textTasks, 1);
    const { RestrictedRuntimeGenerator } = await import('../packages/infra/agent/runtime-generator.ts');
    let started = 0; const adapter = new RestrictedRuntimeGenerator(destination, { factory: () => { started++; throw new Error('must not start'); } });
    try { assert.deepEqual(await adapter.reconcile({ requestId, stage: 'write', inputHash, configurationHash, input: {}, outputSchema: {} }), { text: '仅此一次生成的原文' }); assert.equal(started, 0); }
    finally { adapter.close(); }
    const check = new DatabaseSync(join(destination, 'dreamer.sqlite'), { readOnly: true });
    try { assert.equal(JSON.parse(String(check.prepare('SELECT body FROM experience_dispatches').get()!.body)).state, 'unknown'); } finally { check.close(); }
    for (const mutate of [(m: any) => { m.textRecovery[0].inputHash = '0'.repeat(64); }, (m: any) => { m.textRecovery[0].configurationHash = '0'.repeat(64); }, (m: any) => { m.textRecovery[0].requestId = randomUUID(); }, (m: any) => { m.textRecovery[0].remote.threadId = '../../forged'; }]) {
      const forged = structuredClone(manifest); mutate(forged); writeFileSync(join(backup, 'backup.json'), JSON.stringify(forged)); const target = join(x.parent, randomUUID()); assert.throws(() => restoreBackup(backup, target)); assert.equal(existsSync(target), false);
    }
  } finally { x.close(); }
});
