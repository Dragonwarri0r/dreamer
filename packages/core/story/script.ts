import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Expected, Id, Ref, ensure, stable, type Actor } from '../../contracts/foundation.ts';
import { ScriptPlanData, ScriptEdit, ScriptPublish, type FixedMedia } from '../../contracts/interactive-script.ts';
import { ScriptRelease } from '../../contracts/experience.ts';
import type { Capability } from '../../contracts/production.ts';
import { scriptExecutionProfileIssue } from '../../contracts/script-production-policy.ts';
import type { Persistence } from '../foundation/ports.ts';
import type { ExperiencePersistence } from '../experience/ports.ts';
import { CommandBus, checkTarget } from '../foundation/commands.ts';
import { DraftDomain, references, type ReferenceReader } from '../modules/authoring.ts';
import { applyScriptOperations } from './rules.ts';
import { validateScript } from './validation.ts';
import { scriptReleaseImpact } from './impact.ts';

export const contentHash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export function mediaPlanId(media: unknown) {
  const h = contentHash(media);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export type ScriptCapabilities = { runtimeText: boolean; runtimeMedia: boolean; activityVersions: string[] };
const noGeneration = (): ScriptCapabilities => ({ runtimeText: false, runtimeMedia: false, activityVersions: ['choice@1'] });

/** The author's script stays independent of every user's runtime instance. */
export class Scripts extends DraftDomain<ScriptPlanData> {
  constructor(
    store: Persistence,
    bus: CommandBus,
    private experience: ExperiencePersistence,
    private read: ReferenceReader,
    private mediaCapabilities: () => Capability[],
    private executionCapabilities: () => ScriptCapabilities = noGeneration,
    private mediaExists: (ref: Ref, pid: string) => boolean = () => true,
    private textFingerprint: () => string | undefined = () => undefined,
    private latestRead?: ReferenceReader,
  ) {
    super('script', ScriptPlanData, store, bus, (plan, pid, actor) => {
      if (actor?.source === 'agent') ensure(plan.policy.maxTextCallsPerRun === 0 && plan.policy.maxMediaJobsPerRun === 0,
        'FORBIDDEN', 'AI 可编排剧本；运行生成额度由作者确认');
      for (const ref of references(plan)) read(ref, pid);
    });
    bus.register('script.edit', ScriptEdit, (p, pid, actor) => {
      const current = this.repo.get(p.id, pid);
      ensure(current.seq === p.expectedSeq, 'CONFLICT', '剧本已更新，请比较后重新提交');
      const next = applyScriptOperations(current.data, p.ops);
      this.assertRules(next, pid);
      return this.update(p.id, pid, p.expectedSeq, next, actor);
    }, true);
    bus.register('script.publish', ScriptPublish, (p, pid) => ({ release: this.publish(pid, p) }), true);
  }

  override update(id: string, pid: string, seq: number, data: ScriptPlanData, actor: Actor) {
    checkTarget(actor, id);
    ensure(actor.source !== 'agent', 'FORBIDDEN', '互动剧本修改请提交 script.propose 局部操作');
    return super.update(id, pid, seq, data, actor);
  }

  assertRules(plan: ScriptPlanData, pid: string) {
    const diagnostics = this.diagnostics(plan, pid, 'draft');
    ensure(!diagnostics.some(d => d.severity === 'error'), 'VALIDATION', '剧本规则无效', { diagnostics });
  }

  diagnostics(plan: ScriptPlanData, pid: string, mode: 'draft' | 'simulation' | 'playback' = 'draft') {
    const diagnostics = validateScript(plan, { mode, readRef: ref => this.read(ref, pid), capabilities: this.executionCapabilities() });
    const add = (ruleId: string, nodeId: string, message: string, fieldPath = 'contentSpec.media') => diagnostics.push({
      severity: mode === 'playback' ? 'error' : 'warning', ruleId, nodeId, fieldPath, message,
    });
    for (const node of plan.nodes) {
      if (node.type !== 'segment') continue;
      const contract=node.contentSpec.mode==='fixed'?undefined:node.contentSpec.generationContract;
      if(contract){
        for(const frame of contract.mediaReferences)try{const artifact=this.read(frame.artifact,pid).data;ensure(['image/png','image/jpeg'].includes(artifact.mediaType)&&this.mediaExists(frame.artifact,pid),'MEDIA_INVALID','批准首尾帧必须是本地可读的固定图像');}catch(error){add('MEDIA_REFERENCE_INVALID',node.id,(error as Error).message,'contentSpec.generationContract.mediaReferences');}
        for(const fallback of contract.boundFallbacks)try{this.validateMedia(pid,fallback.media);}catch(error){add('FALLBACK_MEDIA_INVALID',node.id,(error as Error).message,'contentSpec.generationContract.boundFallbacks');}
      }
      if(node.contentSpec.mode==='template')for(const variant of node.contentSpec.variants){try{this.validateMedia(pid,variant.media);for(const cue of plan.cues.filter(c=>c.segmentNodeId===node.id)){ensure(cue.resolvedBinding?.planId===mediaPlanId(variant.media)&&cue.resolvedBinding.contentHash===variant.media.contentHash&&cue.resolvedBinding.fps===variant.media.fps&&cue.deadlineFrame<=variant.media.toFrame-variant.media.fromFrame,'VALIDATION','模板互动时码没有绑定全部可选媒体；请在前置固定片段设置输入');}}catch(error){add('TEMPLATE_MEDIA_INVALID',node.id,(error as Error).message,'contentSpec.variants');}}
      const media = node.contentSpec.mode === 'fixed' ? node.contentSpec.media : undefined;
      if (!media) continue;
      try {
        this.validateMedia(pid, media);
        for (const cue of plan.cues.filter(c => c.segmentNodeId === node.id)) {
          const binding = cue.resolvedBinding;
          if (!binding || binding.planId !== mediaPlanId(media) || binding.contentHash !== media.contentHash || binding.fps !== media.fps ||
            binding.appearFrame > cue.deadlineFrame || cue.deadlineFrame > media.toFrame - media.fromFrame) {
            add('ANCHOR_STALE', node.id, '互动时码未绑定当前片段，请重新定位', `cues.${cue.id}.resolvedBinding`);
          }
        }
      } catch (error) { add('MEDIA_NOT_READY', node.id, (error as Error).message); }
    }
    return diagnostics;
  }

  validateMedia(pid: string, media: z.infer<typeof FixedMedia>) {
    const build = this.read(media.buildRef, pid).data;
    ensure(build.output, 'MEDIA_INVALID', '固定片段的 Build 尚未生成');
    const artifact = this.read(build.output, pid).data;
    ensure(artifact.mediaType === 'video/mp4' && artifact.sha256 === media.contentHash, 'MEDIA_INVALID', '固定片段素材已变化');
    ensure(this.mediaExists(build.output, pid), 'MEDIA_INVALID', '固定片段文件缺失');
    ensure(media.fps === build.snapshot.fps && media.toFrame <= build.range.endFrame - build.range.startFrame,
      'MEDIA_INVALID', '片段范围或时间基准与固定 Build 不符');
    ensure(artifact.durationSeconds && media.toFrame / media.fps <= artifact.durationSeconds + 1 / media.fps,
      'MEDIA_INVALID', '片段范围超过实际视频时长');
    return { build, artifact, artifactRef: build.output as Ref };
  }

  private dependencies(pid: string, plan: ScriptPlanData) {
    const found = new Map<string, Ref>();
    const queue = references(plan);
    while (queue.length) {
      const ref = queue.shift()!, key = stable(ref);
      if (found.has(key)) continue;
      ensure(found.size < 20000, 'VALIDATION', '固定依赖过多，请缩小剧本范围');
      const row = this.read(ref, pid);
      found.set(key, ref);
      queue.push(...references(row.data));
    }
    return [...found.values()];
  }

  publish(pid: string, input: z.infer<typeof ScriptPublish>) {
    const current = this.repo.get(input.id, pid);
    ensure(current.seq === input.expectedSeq, 'CONFLICT', '剧本已更新，请重新检查发布版本');
    const diagnostics = this.diagnostics(current.data, pid, input.kind);
    ensure(!diagnostics.some(d => d.severity === 'error'), 'VALIDATION', '发布检查未通过', { diagnostics });
    const policy = current.data.policy;
    const needsGeneration = current.data.nodes.some(n => n.type === 'segment' && (n.mode === 'generated' ||
      n.contentSpec.mode === 'template' && !!n.contentSpec.generationContract)) || current.data.activities.some(a => a.type === 'text-intent');
    if (input.kind === 'playback' && needsGeneration) {
      ensure(input.confirmGeneration, 'FORBIDDEN', '请确认本版本的生成范围与次数上限');
      for (const profile of policy.executionProfiles) {
        const capability = this.mediaCapabilities().find(c => c.id === profile.provider);
        const issue = scriptExecutionProfileIssue(profile, capability);
        if (issue) ensure(false, issue.code, issue.message, { fieldPath: issue.fieldPath, provider: profile.provider, profile: profile.profile });
      }
    }
    const scriptRef = this.checkpoint(current.id, pid, current.seq);
    const dependencyRefs = this.dependencies(pid, current.data);
    const createdAt = new Date().toISOString();
    const generationAuthorization = input.kind === 'playback' && needsGeneration ? {
      policyHash: contentHash(policy), confirmedAt: createdAt, source: 'human' as const, textConfigurationFingerprint: this.textFingerprint(),
    } : undefined;
    const manifest = { scriptRef, snapshot: current.data, dependencyRefs, policy, kind: input.kind, generationAuthorization };
    const release = ScriptRelease.parse({
      id: randomUUID(), projectId: pid, schemaVersion: 1, ...manifest, manifestHash: contentHash(manifest),
      activityVersions: current.data.activities.map(a => ({ type: a.type, version: a.version })), createdAt,
      ...(input.kind === 'playback' ? { publishedAt: createdAt } : {}),
    });
    const existing=this.experience.list<ScriptRelease>('releases',{projectId:pid}).find(r=>r.data.manifestHash===release.manifestHash);if(existing)return existing.data;
    this.experience.create('releases', { projectId: pid }, release, release.id);
    return release;
  }

  releases(pid: string, scriptId: string) {
    this.repo.get(scriptId, pid);
    return this.experience.list<ScriptRelease>('releases', { projectId: pid })
      .filter(r => r.data.scriptRef.id === scriptId && r.data.kind === 'playback').map(r => r.data);
  }

  readPage(pid: string, ref: Ref, offset = 0, limit = 20) {
    ensure(ref.kind === 'script', 'VALIDATION', '请读取固定剧本版本');
    ensure(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, 'VALIDATION', '分页范围无效');
    const row = this.repo.at(ref, pid), nodes = row.data.nodes.slice(offset, offset + limit);
    return { id: row.id, seq: row.seq, title: row.data.title, ref, nodes, variables: row.data.variables,
      activities: row.data.activities.filter(a => nodes.some(n => n.type === 'activity' && n.activityId === a.id)),
      cues: row.data.cues.filter(c => nodes.some(n => n.id === c.segmentNodeId)), policy: row.data.policy,
      contentPage: { offset, limit, total: row.data.nodes.length, partial: offset !== 0 || nodes.length !== row.data.nodes.length,
        nextOffset: offset + nodes.length < row.data.nodes.length ? offset + nodes.length : null } };
  }

  impact(pid: string, id: string) {
    const current=this.repo.get(id,pid);
    const comparisons=this.releases(pid,id).map(release=>scriptReleaseImpact(release,current.data,this.read,this.latestRead??this.read,pid));
    return {scriptRef:{kind:'script',id,seq:current.seq},releases:comparisons.map(result=>result.release),items:comparisons.flatMap(result=>result.items)};
  }
}
