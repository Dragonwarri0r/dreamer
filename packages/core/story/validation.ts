import { type Ref } from '../../contracts/foundation.ts';
import { ScriptPlanData, type ScriptNode, type Condition, type Effect, type GenerationContract } from '../../contracts/interactive-script.ts';
import { ChoiceActivity, TextIntentActivity, type RuleValue } from '../../contracts/activities.ts';
import { assertCondition, conditionVariableKeys, valueMatches } from './rules.ts';

export type ScriptDiagnostic = { severity: 'error' | 'warning'; ruleId: string; nodeId?: string; fieldPath: string; message: string };
export type ScriptValidationOptions = {
  mode?: 'draft' | 'simulation' | 'playback'; readRef?: (ref: Ref) => unknown;
  capabilities?: { activityVersions?: string[]; runtimeText?: boolean; runtimeMedia?: boolean };
};
export function nodeTargets(node: ScriptNode): string[] {
  return node.type === 'ending' ? [] : node.type === 'branch' ? [...node.cases.map(item => item.to), node.fallback.to] : [node.next];
}
export function collectScriptRefs(plan: ScriptPlanData): Ref[] {
  const refs = new Map<string, Ref>();
  const add = (ref: Ref) => refs.set(`${ref.kind}:${ref.id}:${ref.seq}`, ref);
  plan.chapterRefs.forEach(add);
  for (const node of plan.nodes) {
    if (node.type === 'checkpoint') node.mediaEntryContract?.resourceRefs.forEach(add);
    if (node.type !== 'segment') continue;
    node.sourceSceneRefs.forEach(add);
    const content = node.contentSpec;
    if (content.mode === 'fixed') { if (content.media) add(content.media.buildRef); }
    else if (content.mode === 'template') content.variants.forEach(item => add(item.media.buildRef));
    const contract = content.mode === 'fixed' ? undefined : content.generationContract;
    if (contract) { contract.sourceRefs.forEach(add); contract.fixedFacts.forEach(item => add(item.sourceRef)); contract.resourceRefs.forEach(add); contract.mediaReferences.forEach(frame=>add(frame.artifact)); contract.boundFallbacks.forEach(fallback=>add(fallback.media.buildRef)); }
  }
  plan.cues.forEach(cue => add(cue.anchor.ref));
  return [...refs.values()];
}
export function validateScript(input: unknown, options: ScriptValidationOptions = {}): ScriptDiagnostic[] {
  const parsed = ScriptPlanData.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map(issue => ({ severity: 'error', ruleId: 'SCHEMA_INVALID', fieldPath: issue.path.join('.'), message: issue.message }));
  const plan = parsed.data, diagnostics: ScriptDiagnostic[] = [], playback = options.mode === 'playback';
  const add = (ruleId: string, fieldPath: string, message: string, nodeId?: string, severity: 'error' | 'warning' = 'error') => diagnostics.push({ severity, ruleId, fieldPath, message, ...(nodeId ? { nodeId } : {}) });
  const unavailable = (ruleId: string, fieldPath: string, message: string, nodeId?: string) => add(ruleId, fieldPath, message, nodeId, playback ? 'error' : 'warning');
  const duplicate = (items: string[], path: string) => { const known = new Set<string>(); items.forEach((id, index) => { if (known.has(id)) add('DUPLICATE_ID', `${path}.${index}`, `重复标识 ${id}`); known.add(id); }); };
  duplicate(plan.nodes.map(node => node.id), 'nodes'); duplicate(plan.variables.map(item => item.key), 'variables');
  duplicate(plan.activities.map(item => item.id), 'activities'); duplicate(plan.cues.map(item => item.id), 'cues');
  duplicate(plan.chapterRefs.map(item => item.id), 'chapterRefs');
  const nodes = new Map(plan.nodes.map(node => [node.id, node])), variables = new Map(plan.variables.map(item => [item.key, item]));
  const chapters = new Set(plan.chapterRefs.map(ref => ref.id)), activities = new Map(plan.activities.map(item => [item.id, item]));
  const checkCondition = (condition: Condition, path: string, nodeId?: string) => { try { assertCondition(condition, plan.variables); } catch (error) { add('CONDITION_INVALID', path, (error as Error).message, nodeId); } };
  const checkReads = (keys: string[], path: string, nodeId: string) => { duplicate(keys, path); keys.forEach((key, i) => { if (!variables.has(key)) add('VARIABLE_UNKNOWN', `${path}.${i}`, `未声明变量 ${key}`, nodeId); }); };
  const checkEffects = (effects: Effect[], sourceId: string, phase: string, path: string, resultFields?: Map<string, { type: string; values?: RuleValue[]; min?: number; max?: number; maxLength?: number }>) => {
    duplicate(effects.map(item => item.id), path);
    effects.forEach((effect, index) => {
      const at = `${path}.${index}`, variable = variables.get(effect.key);
      if (!variable) { add('VARIABLE_UNKNOWN', `${at}.key`, `未声明变量 ${effect.key}`, sourceId); return; }
      if (effect.commitAt !== phase) add('EFFECT_PHASE', `${at}.commitAt`, `此位置只允许 ${phase}`, sourceId);
      if (!variable.allowedWriters.some(writer => writer.sourceId === sourceId && writer.commitAt === phase)) add('WRITER_FORBIDDEN', `${at}.key`, `节点无权写入 ${effect.key}`, sourceId);
      if (effect.op === 'unsetSegment') { if (variable.scope !== 'segment') add('EFFECT_SCOPE', at, '只能清理 segment 变量', sourceId); return; }
      if (effect.op === 'increment' && variable.type !== 'integer') add('EFFECT_TYPE', at, 'increment 目标必须是整数', sourceId);
      if (effect.value.source === 'constant') {
        if (effect.op === 'increment') { if (typeof effect.value.value !== 'number' || !Number.isSafeInteger(effect.value.value)) add('EFFECT_TYPE', `${at}.value`, '增量必须是整数', sourceId); }
        else if (!valueMatches(variable, effect.value.value)) add('EFFECT_TYPE', `${at}.value`, '常量类型或范围不符', sourceId);
      } else {
        const field = resultFields?.get(effect.value.field);
        if (!field) add('RESULT_FIELD_UNKNOWN', `${at}.value.field`, '结果字段未声明；只允许直接字段', sourceId);
        else if (effect.op === 'increment') { if (field.type !== 'integer') add('EFFECT_TYPE', `${at}.value`, '增量结果必须是整数', sourceId); }
        else if (field.values) { if (field.values.some(value => !valueMatches(variable, value))) add('EFFECT_TYPE', `${at}.value`, '活动结果可能超出变量范围', sourceId); }
        else if (field.type !== variable.type || (variable.type === 'integer' && ((field.min ?? -Infinity) < variable.min || (field.max ?? Infinity) > variable.max)) || (variable.type === 'text' && (field.maxLength ?? Infinity) > variable.maxLength)) add('EFFECT_TYPE', `${at}.value`, '活动字段与目标变量类型或范围不兼容', sourceId);
      }
    });
  };
  const refCache = new Map<string, unknown>();
  if (options.readRef) for (const ref of collectScriptRefs(plan)) {
    const key = `${ref.kind}:${ref.id}:${ref.seq}`;
    try { const value = options.readRef(ref); if (value === undefined || value === null) throw new Error('引用不存在'); refCache.set(key, value && typeof value === 'object' && 'data' in value ? (value as { data: unknown }).data : value); }
    catch (error) { add('REF_UNAVAILABLE', `references.${key}`, (error as Error).message); }
  }
  const refData = (ref: Ref): any => refCache.get(`${ref.kind}:${ref.id}:${ref.seq}`);
  plan.chapterRefs.forEach((ref, i) => { if (ref.kind !== 'chapter') add('REF_KIND', `chapterRefs.${i}`, '章节来源必须是 Chapter'); });
  for (const [index, variable] of plan.variables.entries()) for (const [writerIndex, writer] of variable.allowedWriters.entries()) {
    const node = nodes.get(writer.sourceId), at = `variables.${index}.allowedWriters.${writerIndex}`;
    if (!node) add('WRITER_UNKNOWN', at, '写入者必须是现有节点');
    else if ((writer.commitAt === 'activityAccepted' && node.type !== 'activity') || (writer.commitAt === 'segmentCompleted' && node.type !== 'segment') || (writer.commitAt === 'checkpointReached' && node.type !== 'checkpoint')) add('WRITER_PHASE', at, '写入阶段不符合节点类型', node.id);
  }
  const validateGeneration = (contract: GenerationContract, nodeId: string, path: string) => {
    checkReads(contract.reads, `${path}.reads`, nodeId);
    if (plan.policy.reviewMode === 'validatedRuntime' && !contract.checks.independentContent) add('CONTENT_REVIEW_REQUIRED', `${path}.checks.independentContent`, '自动准入必须有独立内容检查；仅结构检查不能授权播放', nodeId);
    contract.entryConditions.forEach((item, i) => checkCondition(item, `${path}.entryConditions.${i}`, nodeId));
    duplicate(contract.outcomes.map(item => item.id), `${path}.outcomes`);
    duplicate(contract.outcomeCases.map(item => item.id), `${path}.outcomeCases`);
    const outcomes = new Set(contract.outcomes.map(item => item.id));
    if (!outcomes.has(contract.fallbackOutcome)) add('OUTCOME_UNKNOWN', `${path}.fallbackOutcome`, '后备结果未定义', nodeId);
    const priorities = new Set<number>();
    contract.outcomeCases.forEach((item, i) => {
      if (priorities.has(item.priority)) add('PRIORITY_DUPLICATE', `${path}.outcomeCases.${i}.priority`, '结果优先级必须唯一', nodeId); priorities.add(item.priority);
      if (!outcomes.has(item.outcomeId)) add('OUTCOME_UNKNOWN', `${path}.outcomeCases.${i}.outcomeId`, '结果未定义', nodeId);
      checkCondition(item.when, `${path}.outcomeCases.${i}.when`, nodeId);
      for (const key of conditionVariableKeys(item.when)) if (!contract.reads.includes(key)) add('READ_NOT_DECLARED', `${path}.reads`, `结果条件读取 ${key}，需声明`, nodeId);
    });
    contract.outcomes.forEach((item, i) => { const source = nodes.get(nodeId); if (source?.type === 'segment') duplicate([...source.completionEffects, ...item.completionEffects].map(effect => effect.id), `${path}.outcomes.${i}.completionEffects`); item.postconditions.forEach((condition, j) => checkCondition(condition, `${path}.outcomes.${i}.postconditions.${j}`, nodeId)); checkEffects(item.completionEffects, nodeId, 'segmentCompleted', `${path}.outcomes.${i}.completionEffects`); });
    for (const condition of contract.entryConditions) for (const key of conditionVariableKeys(condition)) if (!contract.reads.includes(key)) add('READ_NOT_DECLARED', `${path}.reads`, `进入条件读取 ${key}，需声明`, nodeId);
    contract.resourceRefs.forEach((ref, i) => { if (ref.kind !== 'resource') add('REF_KIND', `${path}.resourceRefs.${i}`, '生成资源必须引用 Resource', nodeId); });
    duplicate(contract.boundFallbacks.map(fallback=>fallback.id),`${path}.boundFallbacks`);
    contract.boundFallbacks.forEach((fallback,i)=>{
      if(!outcomes.has(fallback.outcomeId))add('OUTCOME_UNKNOWN',`${path}.boundFallbacks.${i}.outcomeId`,'后备必须绑定本规范预定义结果',nodeId);
      fallback.entryConditions.forEach((condition,j)=>{checkCondition(condition,`${path}.boundFallbacks.${i}.entryConditions.${j}`,nodeId);for(const key of conditionVariableKeys(condition))if(!contract.reads.includes(key))add('READ_NOT_DECLARED',`${path}.reads`,`后备进入条件读取 ${key}，需声明`,nodeId);});
    });
    contract.mediaReferences.forEach((frame,i)=>{const artifact=refData(frame.artifact);if(artifact&&!['image/png','image/jpeg'].includes(artifact.mediaType))add('MEDIA_REFERENCE_TYPE',`${path}.mediaReferences.${i}`,'首尾帧必须是已固定的图像素材',nodeId);});
    if (contract.limits.maxShots > plan.policy.maxShotsPerSegment || contract.limits.maxTextCalls > plan.policy.maxTextCallsPerRun || contract.limits.maxMediaJobs > plan.policy.maxMediaJobsPerRun || contract.limits.maxRepairAttempts > plan.policy.maxRepairAttempts) add('BUDGET_CONTRACT', `${path}.limits`, '节点额度超过发布策略', nodeId);
    if (!options.capabilities?.runtimeText) unavailable('CAPABILITY_TEXT', path, '动态写作执行器未接入', nodeId);
    if (!options.capabilities?.runtimeMedia) unavailable('CAPABILITY_MEDIA', path, '动态媒体执行器未接入', nodeId);
    if (!plan.policy.executionProfiles.length) unavailable('EXECUTION_PROFILE_REQUIRED', 'policy.executionProfiles', '动态媒体需固定无凭据执行配置', nodeId);
  };
  for (const [index, node] of plan.nodes.entries()) {
    const path = `nodes.${index}`;
    if (node.chapterId && !chapters.has(node.chapterId)) add('CHAPTER_UNKNOWN', `${path}.chapterId`, '节点章节不在 chapterRefs 中', node.id);
    for (const target of nodeTargets(node)) if (!nodes.has(target)) add('TARGET_UNKNOWN', `${path}.next`, `目标节点不存在 ${target}`, node.id);
    if (node.type === 'branch') {
      const priorities = new Set<number>(); duplicate([...node.cases.map(item => item.id), node.fallback.id], `${path}.cases`);
      if (node.cases.length + 1 > plan.policy.maxBranchesPerDecision) add('BRANCH_LIMIT', `${path}.cases`, '分支出口数量超过策略', node.id);
      node.cases.forEach((item, i) => { if (priorities.has(item.priority)) add('PRIORITY_DUPLICATE', `${path}.cases.${i}.priority`, '分支优先级必须唯一', node.id); priorities.add(item.priority); checkCondition(item.when, `${path}.cases.${i}.when`, node.id); });
    } else if (node.type === 'checkpoint') {
      node.requires.forEach((condition, i) => checkCondition(condition, `${path}.requires.${i}`, node.id));
      checkEffects(node.commitEffects, node.id, 'checkpointReached', `${path}.commitEffects`);
    } else if (node.type === 'activity') {
      const activity = activities.get(node.activityId);
      if (!activity) { add('ACTIVITY_UNKNOWN', `${path}.activityId`, '活动不存在', node.id); continue; }
      checkReads(activity.reads, `${path}.activity.reads`, node.id);
      const choice = ChoiceActivity.safeParse(activity), intent = TextIntentActivity.safeParse(activity), fields = new Map<string, { type: string; values?: RuleValue[]; min?: number; max?: number; maxLength?: number }>();
      if (choice.success) { duplicate(choice.data.config.options.map(item => item.id), `${path}.activity.config.options`); fields.set('optionId', { type: 'enum', values: choice.data.config.options.map(item => item.id) }); }
      else if (intent.success) {
        duplicate(intent.data.config.intents.map(item => item.id), `${path}.activity.config.intents`);
        duplicate(intent.data.config.extractedFields.map(item => item.key), `${path}.activity.config.extractedFields`);
        fields.set('intentId', { type: 'enum', values: intent.data.config.intents.map(item => item.id) });
        for (const field of intent.data.config.extractedFields) {
          if (['intentId', 'optionId', 'interpretationRef'].includes(field.key)) add('RESULT_FIELD_RESERVED', `${path}.activity.config.extractedFields`, '提取字段不能覆盖保留键', node.id);
          else fields.set(field.key, field);
          if (field.type === 'integer' && field.min > field.max) add('RESULT_FIELD_RANGE', `${path}.activity.config.extractedFields`, '提取字段范围倒置', node.id);
        }
        if (!options.capabilities?.runtimeText) unavailable('CAPABILITY_TEXT', `${path}.activity`, '自由文本解释器未接入', node.id);
      } else {
        if (!options.capabilities?.activityVersions?.includes(`${activity.type}@${activity.version}`)) unavailable('ACTIVITY_UNSUPPORTED', `${path}.activity`, `未实现活动 ${activity.type}@${activity.version}`, node.id);
      }
      checkEffects(activity.resultMapping, node.id, 'activityAccepted', `${path}.activity.resultMapping`, fields);
      if (activity.skipPolicy.mode === 'allowed') {
        const result = activity.skipPolicy.result;
        for (const effect of activity.resultMapping) if (effect.op !== 'unsetSegment' && effect.value.source === 'result') {
          const variable = variables.get(effect.key), value = result[effect.value.field];
          if (value === undefined || (effect.op === 'set' && variable && !valueMatches(variable, value)) || (effect.op === 'increment' && typeof value !== 'number')) add('SKIP_RESULT_INVALID', `${path}.activity.skipPolicy`, '跳过结果不能满足映射', node.id);
        }
      }
    } else if (node.type === 'segment') {
      if (node.mode !== node.contentSpec.mode) add('SEGMENT_MODE', `${path}.contentSpec.mode`, '片段模式不一致', node.id);
      if (node.mode !== 'generated' && !node.sourceSceneRefs.length) add('SOURCE_REQUIRED', `${path}.sourceSceneRefs`, '固定/模板片段必须有来源场景', node.id);
      node.sourceSceneRefs.forEach((ref, i) => { if (ref.kind !== 'scene') add('REF_KIND', `${path}.sourceSceneRefs.${i}`, '来源必须是 Scene', node.id); const scene = refData(ref); if (scene && node.chapterId && scene.chapterId !== node.chapterId) add('SCENE_CHAPTER', `${path}.sourceSceneRefs.${i}`, '场景不属于节点章节', node.id); });
      checkEffects(node.completionEffects, node.id, 'segmentCompleted', `${path}.completionEffects`);
      const content = node.contentSpec;
      if (content.mode === 'fixed') {
        if (!content.media) unavailable('MEDIA_MISSING', `${path}.contentSpec.media`, '固定片段尚未绑定可播放 Build', node.id);
        else { const build = refData(content.media.buildRef); if (build && (build.state !== 'completed' || !build.output)) unavailable('BUILD_NOT_READY', `${path}.contentSpec.media`, 'Build 尚未完成', node.id); }
      } else if (content.mode === 'template') {
        checkReads(content.reads, `${path}.contentSpec.reads`, node.id);
        const keys = [...content.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]!);
        for (const key of keys) if (!content.reads.includes(key) || !variables.has(key)) add('TEMPLATE_VARIABLE', `${path}.contentSpec.text`, `未声明模板变量 ${key}`, node.id);
        content.variants.forEach((variant, i) => {
          checkCondition(variant.when, `${path}.contentSpec.variants.${i}.when`, node.id);
          for (const key of conditionVariableKeys(variant.when)) if (!content.reads.includes(key)) add('READ_NOT_DECLARED', `${path}.contentSpec.reads`, `模板变体条件读取 ${key}，需声明`, node.id);
        });
        if (new Set(content.variants.map(variant => variant.outcomeId)).size > 1) add('TEMPLATE_OUTCOME', `${path}.contentSpec.variants`, '有限媒体变体必须绑定同一叙事结果', node.id);
        if (!content.variants.length && !content.generationContract) unavailable('TEMPLATE_MEDIA', `${path}.contentSpec`, '模板变化尚无匹配媒体或生成策略', node.id);
        if (content.generationContract) validateGeneration(content.generationContract, node.id, `${path}.contentSpec.generationContract`);
      } else validateGeneration(content.generationContract, node.id, `${path}.contentSpec.generationContract`);
    }
  }
  if (!nodes.has(plan.entryNodeId)) add('ENTRY_UNKNOWN', 'entryNodeId', '入口节点不存在');
  const visited = new Set<string>(), visiting = new Set<string>(), endingReachable = new Map<string, boolean>(), dynamicDepth = new Map<string, number>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) { add('GRAPH_CYCLE', 'nodes', '首版不支持故事线循环', id); return false; }
    if (visited.has(id)) return endingReachable.get(id) ?? false;
    const node = nodes.get(id); if (!node) return false;
    visiting.add(id); const targets = nodeTargets(node);
    const reaches = node.type === 'ending' || targets.map(walk).every(Boolean);
    dynamicDepth.set(id, (node.type === 'segment' && (node.mode === 'generated' || node.contentSpec.mode === 'template' && !!node.contentSpec.generationContract) ? 1 : 0) + Math.max(0, ...targets.map(target => dynamicDepth.get(target) ?? 0)));
    visiting.delete(id); visited.add(id); endingReachable.set(id, reaches);
    if (!reaches) add('ENDING_UNREACHABLE', 'nodes', '并非每条结构路径均可抵达结局', id);
    return reaches;
  };
  walk(plan.entryNodeId);
  for (const node of plan.nodes) if (!visited.has(node.id)) add('NODE_UNREACHABLE', 'nodes', '节点无法从入口抵达', node.id);
  if (!plan.nodes.some(node => node.type === 'ending')) add('ENDING_REQUIRED', 'nodes', '剧本需要至少一个结局');
  if ((dynamicDepth.get(plan.entryNodeId) ?? 0) > plan.policy.maxDynamicNodesPerRun) add('DYNAMIC_LIMIT', 'policy.maxDynamicNodesPerRun', '存在路径超过动态节点上限');
  const cueSegments = new Set<string>();
  for (const [index, cue] of plan.cues.entries()) {
    const path = `cues.${index}`, segment = nodes.get(cue.segmentNodeId), activity = nodes.get(cue.activityNodeId);
    if (cueSegments.has(cue.segmentNodeId)) add('CUE_LIMIT', path, '每个片段最多一个提前输入', cue.segmentNodeId); cueSegments.add(cue.segmentNodeId);
    if (segment?.type !== 'segment' || activity?.type !== 'activity' || segment.next !== activity.id) add('CUE_SUCCESSOR', path, '提前输入必须是片段直接后继活动', cue.segmentNodeId);
    if (!['scene', 'shot'].includes(cue.anchor.ref.kind)) add('ANCHOR_KIND', `${path}.anchor.ref`, '锚点必须是 Scene/ScriptBlock/Shot', cue.segmentNodeId);
    if (segment?.type === 'segment' && cue.anchor.ref.kind === 'scene' && !segment.sourceSceneRefs.some(ref => ref.id === cue.anchor.ref.id && ref.seq === cue.anchor.ref.seq)) add('ANCHOR_SOURCE', `${path}.anchor.ref`, '锚点不属于当前片段固定来源', cue.segmentNodeId);
    const anchor = refData(cue.anchor.ref);
    if (anchor && cue.anchor.ref.kind === 'shot' && segment?.type === 'segment' && !segment.sourceSceneRefs.some(ref => ref.id === anchor.scene?.id && ref.seq === anchor.scene?.seq)) add('ANCHOR_SOURCE', `${path}.anchor.ref`, '镜头锚点不属于当前片段固定来源', cue.segmentNodeId);
    if (cue.anchor.blockId && cue.anchor.ref.kind !== 'scene') add('ANCHOR_KIND', `${path}.anchor.blockId`, 'ScriptBlock 锚点必须绑定 Scene', cue.segmentNodeId);
    if (anchor && cue.anchor.blockId && !anchor.blocks?.some((block: any) => block.id === cue.anchor.blockId)) add('ANCHOR_STALE', `${path}.anchor.blockId`, 'ScriptBlock 锚点不存在', cue.segmentNodeId);
    const dynamic = segment?.type === 'segment' && (segment.contentSpec.mode === 'generated' || segment.contentSpec.mode === 'template' && !!segment.contentSpec.generationContract && !segment.contentSpec.variants.length);
    if(dynamic&&cue.resolvedBinding)add('ANCHOR_RUNTIME_STALE',`${path}.resolvedBinding`,'动态实例尚未生成，不能发布预估的已解析媒体时码；请清除后在实际媒体完成时定位',cue.segmentNodeId);
    if (!cue.resolvedBinding && dynamic) add('ANCHOR_RUNTIME_REQUIRED',`${path}.resolvedBinding`,'动态媒体完成后需作者定位实际时码；定位前实例不可播放',cue.segmentNodeId,'warning');
    else if (!cue.resolvedBinding) unavailable('ANCHOR_UNRESOLVED', `${path}.resolvedBinding`, 'Cue 尚无可信媒体时码；模拟只能用占位', cue.segmentNodeId);
    else {
      if (cue.deadlineFrame < cue.resolvedBinding.appearFrame) add('CUE_TIME', `${path}.deadlineFrame`, '截止早于出现', cue.segmentNodeId);
      if (segment?.type === 'segment' && segment.contentSpec.mode === 'fixed' && segment.contentSpec.media) {
        const media = segment.contentSpec.media, binding = cue.resolvedBinding;
        if (binding.contentHash !== media.contentHash || binding.fps !== media.fps) add('ANCHOR_STALE', `${path}.resolvedBinding`, 'Cue 媒体绑定已变化', segment.id);
        if (cue.deadlineFrame >= media.toFrame - media.fromFrame) add('CUE_TIME', `${path}.deadlineFrame`, 'Cue 超出片段局部时基', segment.id);
      }
    }
  }
  return diagnostics;
}
