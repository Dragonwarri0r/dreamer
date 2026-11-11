import { createHash, randomUUID } from 'node:crypto';
import { InstanceProposal, type RuntimeAdoptionSource } from '../../contracts/adoption.ts';
import { SceneData } from '../../contracts/creative.ts';
import { ChapterData } from '../../contracts/longform.ts';
import { ensure, stable, type Actor, type Ref } from '../../contracts/foundation.ts';
import { type ExperienceRun, type RuntimeVisit, type ScriptRelease, type SegmentInstance, type SegmentScriptV1 } from '../../contracts/experience.ts';
import { Proposal } from '../../contracts/review.ts';
import { CommandBus, checkTarget } from '../foundation/commands.ts';
import type { Persistence } from '../foundation/ports.ts';
import type { DraftDomain } from '../modules/authoring.ts';
import type { Review } from '../modules/review.ts';
import type { ExperiencePersistence, RunScope } from './ports.ts';

const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const refs = (values: Ref[]) => [...new Map(values.map(ref => [stable(ref), ref])).values()];
type Result = { instanceId: string; resultRevision: number; contentHash: string; script: SegmentScriptV1; fallback?: NonNullable<SegmentInstance['fallbackResult']> };

/** Explicit disclosure creates an ordinary, approval-bound proposal; it never runs a model. */
export class RuntimeAdoption {
  constructor(_store: Persistence, private experience: ExperiencePersistence, bus: CommandBus, private review: Review,
    private domains: { scene: DraftDomain<SceneData>; chapter: DraftDomain<ChapterData> }) {
    review.validateRuntimeSource = (pid, source) => this.validateSource(pid, source);
    bus.register('instance.propose', InstanceProposal, (input, pid, actor) => this.propose(pid, input, actor), true);
  }

  private content(scope: RunScope, instanceId: string, revision: number) {
    const run = this.experience.get<ExperienceRun>('runs', scope.runId, scope).data;
    const instance = this.experience.get<SegmentInstance>('instances', instanceId, scope).data;
    ensure(instance.runId === run.id && instance.releaseId === run.releaseId, 'FORBIDDEN', '实例不属于所选体验');
    const visit = this.experience.get<RuntimeVisit>('visits', instance.visitId, scope).data;
    ensure(visit.instanceId === instance.id && visit.status !== 'planned', 'FORBIDDEN', '不能提取尚未到达的预生成正文');
    ensure(!['planned', 'writing', 'checking', 'waitingReview', 'unknown', 'cancelled', 'stale'].includes(instance.status), 'CONFLICT', '请先完成当前正文的检查和确认');
    const release = this.experience.get<ScriptRelease>('releases', run.releaseId, { projectId: scope.projectId }).data;
    ensure(release.manifestHash === run.manifestHash, 'CONFLICT', '体验固定来源不匹配');
    if (instance.fallbackResult) {
      ensure(instance.resultRevision === revision, 'CONFLICT', '实例后备正文修订已变化，请重新读取后提取');
      const archived = this.experience.list<Result>('results', scope).find(row => row.data.instanceId === instance.id && row.data.resultRevision === revision)?.data;
      ensure(archived?.fallback && archived.contentHash === instance.fallbackResult.contentHash && stable(archived.fallback) === stable(instance.fallbackResult), 'CONFLICT', '固定后备正文归档缺失或与实例不一致');
      return { run, instance, script: undefined, text: archived.fallback.text, contentHash: archived.contentHash, sourceRefs: refs([...instance.sourceRefs, archived.fallback.media.buildRef]), format: 'fallback' as const };
    }
    if (instance.scriptResult) {
      ensure(instance.resultRevision === revision, 'CONFLICT', '实例正文修订已变化，请重新读取后提取');
      const passed = (stage: string) => instance.checks.some(check => check.stage === stage && check.resultRevision === revision && check.status === 'passed');
      ensure(passed('structure') && passed(release.policy.reviewMode === 'authorReview' ? 'authorReview' : 'content'), 'FORBIDDEN', '不能提取尚未通过正文审阅的结果');
      ensure(!instance.checks.some(check => ['structure', 'content', 'authorReview'].includes(check.stage) && check.status === 'failed' && (check.resultRevision === undefined || check.resultRevision === revision)), 'FORBIDDEN', '当前正文仍有未通过的检查');
      const archived = this.experience.list<Result>('results', scope).find(row => row.data.instanceId === instance.id && row.data.resultRevision === revision)?.data;
      ensure(archived && archived.contentHash === hash(archived.script) && archived.contentHash === hash(instance.scriptResult), 'CONFLICT', '固定正文归档缺失或与实例不一致');
      return { run, instance, script: archived.script, text: undefined, contentHash: archived.contentHash, sourceRefs: refs([...instance.sourceRefs, ...archived.script.sourceRefs]), format: 'generated' as const };
    }
    ensure(instance.templateResult && revision === 1 && (instance.resultRevision === undefined || instance.resultRevision === 1), 'CONFLICT', '没有该修订的固定模板正文');
    return { run, instance, script: undefined, text: instance.templateResult.text, contentHash: instance.templateResult.contentHash, sourceRefs: refs(instance.sourceRefs), format: 'template' as const };
  }

  validateSource(pid: string, source: RuntimeAdoptionSource) {
    const run = this.experience.lookupRun<ExperienceRun>(pid, source.content.runId);
    const selected = this.content({ projectId: pid, uid: run.data.uid, runId: run.id }, source.content.instanceId, source.content.resultRevision);
    ensure(selected.instance.nodeId === source.nodeId && selected.instance.releaseId === source.releaseId && selected.format === source.format && selected.contentHash === source.content.contentHash && stable(selected.sourceRefs) === stable(source.sourceRefs), 'CONFLICT', '提案绑定的个人实例来源已变化');
    ensure(source.sceneIds.every(id => selected.script?.scenes.some(scene => scene.id === id)), 'CONFLICT', '提案绑定的来源场景已变化');
  }

  private propose(pid: string, input: InstanceProposal, actor: Actor) {
    checkTarget(actor, input.target.id);
    const selected = this.content({ projectId: pid, uid: input.uid, runId: input.runId }, input.instanceId, input.resultRevision);
    const kind = input.target.kind as 'scene' | 'chapter', domain = this.domains[kind];
    const current = domain.repo.get(input.target.id, pid);
    ensure(current.seq === input.target.seq, 'CONFLICT', '目标正文已变化，请重新选择固定目标版本');
    const base = domain.repo.at(input.target, pid);
    const sceneIds = input.sceneIds ?? selected.script?.scenes.map(scene => scene.id) ?? [];
    ensure(new Set(sceneIds).size === sceneIds.length && sceneIds.every(id => selected.script?.scenes.some(scene => scene.id === id)), 'VALIDATION', '提取场景必须属于当前固定正文且不能重复');
    const scenes = selected.script?.scenes.filter(scene => sceneIds.includes(scene.id)) ?? [];
    ensure(!selected.script || scenes.length > 0, 'VALIDATION', '请选择需要提取的来源场景');
    ensure(kind !== 'scene' || !selected.script || scenes.length === 1, 'VALIDATION', '写入场景时请选择一个来源场景；整段内容可提取到章节');
    let data: SceneData | ChapterData;
    if (kind === 'scene') {
      // Fresh block IDs avoid collisions with prior adoptions while preserving the frozen source reference.
      const blocks = selected.script ? scenes[0].blocks.map(block => ({ ...block, id: randomUUID() })) : (selected.text!.match(/[\s\S]{1,12000}/g)??['']).map(text=>({ id: randomUUID(), type: 'action' as const, text, speaker: '' }));
      const before = SceneData.parse(base.data);
      data = SceneData.parse({ ...before, blocks: input.mode === 'append' ? [...before.blocks, ...blocks] : blocks });
    } else {
      const text = selected.script ? scenes.map(scene => `${scene.title}\n${scene.blocks.map(block => `${block.speaker ? block.speaker + '：' : ''}${block.text}`).join('\n')}`).join('\n\n') : selected.text!;
      const before = ChapterData.parse(base.data);
      data = ChapterData.parse({ ...before, body: input.mode === 'append' && before.body ? `${before.body}\n\n${text}` : text });
    }
    const source: RuntimeAdoptionSource = { content: { runId: input.runId, instanceId: input.instanceId, resultRevision: input.resultRevision, contentHash: selected.contentHash }, releaseId: selected.instance.releaseId, nodeId: selected.instance.nodeId, sourceRefs: selected.sourceRefs, sceneIds, format: selected.format, mode: input.mode, target: input.target };
    const title = `个人实例提取：${current.data.title}`;
    const proposal = Proposal.parse({ title, reason: `作者已明确将所选个人正文提取到工作区；${input.mode === 'append' ? '追加到' : '替换'}所选${kind === 'scene' ? '场景' : '章节'}，采用前仍需审阅批准。`, reads: [input.target], groups: [{ id: randomUUID(), title, operations: [{ kind, id: current.id, expectedSeq: current.seq, base: input.target, data }] }] });
    return this.review.createRuntimeProposal(pid, proposal, source, actor);
  }
}
