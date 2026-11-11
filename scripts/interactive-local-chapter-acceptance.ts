/** Explicit text-only acceptance; never imported by the application or started by npm test.
 * node --import tsx scripts/interactive-local-chapter-acceptance.ts generate
 *   --source-identity <completed segment identity.json> --root <new isolated directory> --out <new evidence directory>
 * The source database is opened read-only. This creates a copied test run, not cross-run product context.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Id, ProjectData, Ref, stable } from '../packages/contracts/foundation.ts';
import { ExperienceRun, RuntimeContentRef, RuntimeVisit, ScriptRelease, SegmentInstance, SegmentScriptV1, Uid } from '../packages/contracts/experience.ts';
import { GenerationContract, ScriptPlanData } from '../packages/contracts/interactive-script.ts';
import { RuntimeGeneration, type PreparationContext, type RuntimeDispatch, type RuntimeTextGenerator } from '../packages/core/experience/generation.ts';
import { LocalRuntimeGenerator } from '../packages/infra/agent/local-runtime-generator.ts';
import { SqliteStore } from '../packages/infra/sqlite.ts';

const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const Identity = z.object({ root: z.string().min(1), projectId: Id, uid: Uid, runId: Id, instanceId: Id, chapterRef: Ref, sceneRef: Ref });
type FrozenSource = { ref: Ref; data: unknown };
export type ChapterSourceEvidence = ReturnType<typeof readChapterSource>;

/** Reads a real, already consumed revision with its fixed author sources; performs no migration or recovery. */
export function readChapterSource(identityPath: string) {
  const identity = Identity.parse(JSON.parse(readFileSync(identityPath, 'utf8'))), sourceRoot = resolve(identity.root);
  const db = new DatabaseSync(join(sourceRoot, 'dreamer.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const body = (table: 'experience_runs' | 'experience_instances' | 'experience_visits', id: string) => {
      const row = db.prepare(`SELECT body FROM ${table} WHERE project_id=? AND uid=? AND run_id=? AND id=?`).get(identity.projectId, identity.uid, identity.runId, id);
      assert.ok(row, `Source ${table} record does not belong to the stated user and run`); return JSON.parse(String(row.body));
    };
    const run = ExperienceRun.parse(body('experience_runs', identity.runId));
    const instance = SegmentInstance.parse(body('experience_instances', identity.instanceId));
    assert.equal(run.mode, 'playback', 'Source must be an actual playback run');
    assert.equal(instance.status, 'consumed', 'Finish and consume the original segment before starting chapter acceptance');
    assert.equal(instance.releaseId, run.releaseId);
    const visit = RuntimeVisit.parse(body('experience_visits', instance.visitId));
    assert.equal(visit.status, 'completed'); assert.equal(visit.instanceId, instance.id);
    assert.ok(instance.scriptResult && instance.resultRevision && !instance.fallbackResult && !instance.templateResult, 'Source must be the consumed generated segment, not an unused draft or a fallback');
    for (const stage of ['structure', 'content', 'authorReview']) assert.ok(instance.checks.some(check => check.stage === stage && check.status === 'passed' && check.resultRevision === instance.resultRevision), `Source ${stage} has not passed for this revision`);
    assert.ok(!instance.checks.some(check => ['structure', 'content', 'authorReview'].includes(check.stage) && check.status === 'failed' && check.resultRevision === instance.resultRevision));
    const releaseRow = db.prepare('SELECT body FROM script_releases WHERE project_id=? AND id=?').get(identity.projectId, run.releaseId);
    assert.ok(releaseRow); const release = ScriptRelease.parse(JSON.parse(String(releaseRow.body)));
    assert.equal(release.manifestHash, run.manifestHash);
    const node = release.snapshot.nodes.find(item => item.id === instance.nodeId);
    assert.ok(node?.type === 'segment' && node.contentSpec.mode === 'generated' && node.contentSpec.generationContract.scope === 'segment', 'Expected a real segment source');
    const resultRow = db.prepare("SELECT body FROM experience_results WHERE project_id=? AND uid=? AND run_id=? AND json_extract(body,'$.instanceId')=? AND json_extract(body,'$.resultRevision')=?").get(identity.projectId, identity.uid, identity.runId, instance.id, instance.resultRevision);
    assert.ok(resultRow, 'Immutable source result is missing');
    const result = JSON.parse(String(resultRow.body)), script = SegmentScriptV1.parse(result.script);
    assert.equal(digest(script), result.contentHash); assert.equal(digest(instance.scriptResult), result.contentHash);
    const refs = [...new Map([...instance.sourceRefs, identity.chapterRef, identity.sceneRef].map(ref => [stable(ref), ref])).values()];
    const sources: FrozenSource[] = refs.map(value => {
      const ref = Ref.parse(value);
      assert.ok(['chapter', 'scene', 'knowledge', 'resource'].includes(ref.kind), 'This text acceptance only copies explicit author text sources');
      const row = db.prepare(`SELECT body FROM ${ref.kind}_revisions WHERE project_id=? AND id=? AND seq=?`).get(identity.projectId, ref.id, ref.seq);
      assert.ok(row, 'Fixed source revision is missing'); return { ref, data: JSON.parse(String(row.body)) };
    });
    const originalRef = RuntimeContentRef.parse({ runId: run.id, instanceId: instance.id, resultRevision: instance.resultRevision, contentHash: result.contentHash });
    const proof = { sourceIdentity: resolve(identityPath), originalRef, sourceRunHash: digest(run), sourceInstanceHash: digest(instance), sourceReleaseHash: digest(release), sourceManifestHash: run.manifestHash, authorSources: sources.map(source => ({ ref: source.ref, contentHash: digest(source.data) })) };
    db.exec('COMMIT');
    return { identity, sourceRoot, run, instance, visit, release, node, script, sources, proof };
  } finally { db.close(); }
}

/** A local acceptance fixture only: copied prior content is owned by the new run, never read across runs. */
export function createChapterAcceptance(source: ChapterSourceEvidence, root: string, generator: RuntimeTextGenerator) {
  const store = new SqliteStore(root), projectId = randomUUID(), runId = randomUUID(), uid = 'chapter-acceptance-reader';
  const now = new Date().toISOString(), scope = { projectId, uid, runId }, chapterNodeId = randomUUID(), endingId = randomUUID();
  store.repository('project', ProjectData).create(projectId, ProjectData.parse({ title: 'SPEC09 整章文本隔离验收', generationLimit: 0 }), projectId);
  const reads = ['intention', 'allowedWait'];
  assert.equal(source.run.variables.intention, 'wait'); assert.equal(source.run.variables.allowedWait, true);
  const contract = GenerationContract.parse({ id: randomUUID(), version: 1, scope: 'chapter', reads, sourceRefs: source.sources.map(item => item.ref),
    entryConditions: [{ op: 'eq', key: 'allowedWait', value: true }],
    narrativeGoal: '写完整一章“灯下等候”。紧接 previousContent 中旅人请求等朋友、守门人准许在门外等待的真实经历。用两到三个场景形成承接、轻微变化、安静收束；不要重新询问刚解决的请求，也不要复述整段前文。必须返回 chapterTitle。正文自然中文，全部 block.text 合计不超过800字。每场一个镜头，每镜头120帧、24fps，总帧数不超过360；所有对白放入对应 scenes[].blocks，资源白名单为空。',
    fixedFacts: [{ key: 'gateClosed', text: '城门始终关闭。只出现身穿蓝袍、手提暖黄色灯笼的守门人；旅人在画外。旅人刚获准在门外等待朋友。朋友本章尚未到达，不能新增人物或进城。', sourceRef: source.identity.sceneRef }],
    allowedChanges: [{ field: 'dialogue', constraint: '守门人简短自然回应旅人在等朋友，避免重复已经完成的许可交涉。' }, { field: 'action', constraint: '守门人提灯、稍移站位或望向门外；保持城门关闭，无新人物。' }, { field: 'description', constraint: '描写灯光和等候的时间感，形成完整章尾。' }],
    outcomeCases: [], fallbackOutcome: 'stillWaiting', outcomes: [{ id: 'stillWaiting', narrativeRequirement: '结尾旅人仍在关闭的城门外等朋友，守门人的既有许可持续有效；不让朋友到场，不进城。', completionEffects: [], postconditions: [{ op: 'eq', key: 'allowedWait', value: true }] }],
    resourceRefs: [], limits: { maxCharacters: 800, maxScenes: 3, maxShots: 3, targetSeconds: 15, maxTextCalls: 4, maxMediaJobs: 0, maxRepairAttempts: 1 }, checks: { structure: true, independentContent: true, mediaReady: true } });
  const chapterNode = { id: chapterNodeId, type: 'segment' as const, mode: 'generated' as const, title: '灯下等候：整章', chapterId: source.identity.chapterRef.id, outlineOrder: 1, sourceSceneRefs: [source.identity.sceneRef], contentSpec: { mode: 'generated' as const, generationContract: contract }, next: endingId };
  const snapshot = ScriptPlanData.parse({ schemaVersion: 1, title: '已消费片段后的整章文本验收', chapterRefs: [source.identity.chapterRef], entryNodeId: source.node.id,
    variables: source.release.snapshot.variables.filter(variable => reads.includes(variable.key)).map(variable => ({ ...variable, initial: source.run.variables[variable.key], allowedWriters: variable.allowedWriters.filter(writer => writer.sourceId === source.node.id) })),
    nodes: [{ ...source.node, outlineOrder: 0, next: chapterNodeId }, chapterNode, { id: endingId, type: 'ending', title: '继续等候', outlineOrder: 2, endingKey: 'waiting', summary: '旅人继续在关闭的城门外等候朋友。' }], activities: [], cues: [],
    policy: { maxDynamicNodesPerRun: 2, maxShotsPerSegment: 3, maxTextCallsPerRun: 4, maxMediaJobsPerRun: 0, maxRepairAttempts: 1, reviewMode: 'authorReview' } });
  const release = ScriptRelease.parse({ id: randomUUID(), projectId, scriptRef: { kind: 'script', id: randomUUID(), seq: 1 }, schemaVersion: 1, kind: 'playback', manifestHash: digest(snapshot), snapshot,
    dependencyRefs: source.sources.map(item => item.ref), activityVersions: [], policy: snapshot.policy, createdAt: now,
    generationAuthorization: { source: 'human', confirmedAt: now, policyHash: digest(snapshot.policy), textConfigurationFingerprint: generator.configuration().fingerprint } });
  store.experience.create('releases', { projectId }, release, release.id);
  const pastVisitId = randomUUID(), visitId = randomUUID(), instanceId = randomUUID();
  const run = ExperienceRun.parse({ id: runId, projectId, uid, releaseId: release.id, manifestHash: release.manifestHash, mode: 'playback', stateSeq: 1, currentNodeId: chapterNodeId, currentVisitId: visitId, status: 'waitingContent',
    variables: Object.fromEntries(reads.map(key => [key, source.run.variables[key]])), committedFacts: source.run.committedFacts.filter(fact => fact.visitId === source.visit.id).map(fact => ({ ...fact, id: randomUUID(), runId, visitId: pastVisitId })), historyCursor: 0, createdAt: now, updatedAt: now });
  store.experience.create('runs', scope, run, run.id);
  const pastVisit = RuntimeVisit.parse({ id: pastVisitId, runId, nodeId: source.node.id, status: 'completed', ordinal: 0, instanceId: source.instance.id, enteredAt: now, completedAt: now, completedPhases: ['segmentCompleted'], exitNodeId: chapterNodeId });
  // A visit cannot reference an instance before it exists; the fixed link is applied after both rows are created.
  store.experience.create('visits', scope, { ...pastVisit, instanceId: undefined }, pastVisit.id);
  const pastInstance = SegmentInstance.parse({ id: source.instance.id, runId, nodeId: source.node.id, visitId: pastVisit.id, releaseId: release.id, inputHash: source.instance.inputHash,
    status: 'consumed', resultRevision: source.instance.resultRevision, scriptResult: source.script, sourceRefs: source.instance.sourceRefs, variableSnapshot: source.instance.variableSnapshot, outcomeId: source.instance.outcomeId, checks: source.instance.checks });
  store.experience.create('instances', scope, pastInstance, pastInstance.id);
  store.experience.save('visits', pastVisit.id, scope, 1, pastVisit);
  store.experience.create('results', scope, { instanceId: pastInstance.id, resultRevision: pastInstance.resultRevision, contentHash: source.proof.originalRef.contentHash, script: source.script });
  const visit = RuntimeVisit.parse({ id: visitId, runId, nodeId: chapterNodeId, status: 'active', ordinal: 1, enteredAt: now });
  store.experience.create('visits', scope, visit, visit.id);
  const instance = SegmentInstance.parse({ id: instanceId, runId, nodeId: chapterNodeId, visitId, releaseId: release.id, inputHash: digest({ runId, nodeId: chapterNodeId, contract, source: source.proof.originalRef }), status: 'planned', sourceRefs: [], variableSnapshot: {} });
  store.experience.create('instances', scope, instance, instance.id);
  const frozen = new Map(source.sources.map(item => [stable(item.ref), item.data]));
  const coordinator = new RuntimeGeneration(store.experience, (ref, pid) => { assert.equal(pid, projectId); assert.ok(frozen.has(stable(ref))); return { data: frozen.get(stable(ref)) }; }, generator, {
    acceptPreparedInternal(s, value) { const row = store.experience.get('instances', value.id, s); store.experience.save('instances', value.id, s, row.seq, value); },
    acceptActivityInternal() { throw new Error('Chapter text acceptance must not interpret or submit an activity'); },
  });
  const node = snapshot.nodes.find(item => item.id === chapterNodeId)!; assert.equal(node.type, 'segment');
  const context: PreparationContext = { principal: { projectId, uid }, run, release, node: node as PreparationContext['node'], visit, instance };
  return { store, coordinator, context, scope, contract,
    copiedRef: RuntimeContentRef.parse({ ...source.proof.originalRef, runId }),
    prepare() { return store.transaction(() => { const prepared = coordinator.prepare(context); store.experience.save('instances', instance.id, scope, 1, prepared); return prepared; }); },
    instance() { return store.experience.get<SegmentInstance>('instances', instance.id, scope).data; },
    close() { coordinator.close(); store.close(); } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--help') { console.log('generate --source-identity <completed segment identity.json> --root <new isolated data dir> --out <new evidence dir>\nExplicit local text calls only; no media; finish the source segment and stop the H3 worker first.'); return; }
  assert.equal(args[0], 'generate', 'Explicit generate action required; this script is not a background task');
  const option = (name: string) => { const index = args.indexOf(name); assert.ok(index > 0 && args[index + 1] && !args[index + 1]!.startsWith('--'), `Missing ${name}`); return resolve(args[index + 1]!); };
  const identityPath = option('--source-identity'), root = option('--root'), out = option('--out');
  assert.equal(args.length, 7, 'Only source-identity, root and out options are supported');
  const source = readChapterSource(identityPath);
  for (const destination of [root, out]) {
    assert.ok(destination !== source.sourceRoot && !destination.startsWith(source.sourceRoot + sep) && !source.sourceRoot.startsWith(destination + sep), 'Acceptance output must not overlap the source database directory');
    assert.ok(!existsSync(destination), 'Acceptance paths must be fresh; never overwrite or implicitly retry prior evidence');
  }
  assert.ok(root !== out && !root.startsWith(out + sep) && !out.startsWith(root + sep), 'Use separate data and report directories');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const generator = new LocalRuntimeGenerator(root, { baseUrl: 'http://127.0.0.1:1235/v1', model: 'dreamer-spec09-text', timeoutMs: 600000, maxTokens: 6000 });
  const test = createChapterAcceptance(source, root, generator);
  save('source-copy.json', { ...source.proof, copiedRuntimeRef: test.copiedRef, note: 'Only this acceptance fixture copies the consumed body into a new run. Runtime context reads that new run; no production cross-run read capability is used.' });
  save('fixed-sources.json', source.sources); save('identity.json', { root, out, ...test.scope, instanceId: test.context.instance.id, releaseId: test.context.release.id, textConfiguration: generator.configuration(), contract: test.contract, startedAt: new Date().toISOString() });
  try {
    test.prepare();
    const writing = test.store.experience.list<RuntimeDispatch>('dispatches', test.scope)[0]!.data;
    assert.deepEqual((writing.request.input.context as { priorInstanceRefs: unknown }).priorInstanceRefs, [test.copiedRef]);
    assert.equal((writing.request.input.previousContent as { script: SegmentScriptV1 }[])[0]!.script.instanceId, test.copiedRef.instanceId);
    save('write-request.json', writing.request);
    await test.coordinator.tick(test.scope);
    const actual = test.instance(), dispatches = test.store.experience.list<RuntimeDispatch>('dispatches', test.scope), usage = test.store.experience.usage(test.scope);
    save('text-result.json', actual); save('dispatches.json', dispatches); save('content-reviews.json', dispatches.filter(row => row.data.stage === 'check').map(row => row.data.result));
    const after = readChapterSource(identityPath); assert.deepEqual(after.proof, source.proof, 'Source evidence changed during isolated acceptance');
    const report = { scope: 'chapter', status: actual.status, sourceUnchanged: true, mediaJobs: usage.runMedia, textCalls: usage.runText, resultRevision: actual.resultRevision,
      scenes: actual.scriptResult?.scenes.length, characters: actual.scriptResult?.scenes.reduce((sum, scene) => sum + scene.blocks.reduce((n, block) => n + block.text.length, 0), 0),
      independentContentPassed: actual.checks.some(check => check.stage === 'content' && check.status === 'passed' && check.resultRevision === actual.resultRevision),
      authorApproved: actual.checks.some(check => check.stage === 'authorReview' && check.status === 'passed' && check.resultRevision === actual.resultRevision),
      humanQualityReview: 'pending: inspect continuity, natural Chinese, causal closure and fixed facts in text-result.json before reporting quality acceptance', finishedAt: new Date().toISOString() };
    save('report.json', report); console.log(JSON.stringify({ ...report, out }));
    assert.equal(actual.status, 'waitingReview', actual.recoveryReason ?? 'Chapter did not reach author review');
    assert.equal(report.independentContentPassed, true); assert.equal(report.authorApproved, false);
    assert.equal(usage.runMedia, 0); assert.equal(actual.scriptResult!.outcomeId, 'stillWaiting');
    assert.ok(actual.scriptResult!.chapterTitle?.trim()); assert.ok(actual.scriptResult!.scenes.length >= 2 && actual.scriptResult!.scenes.length <= 3);
  } finally { test.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
