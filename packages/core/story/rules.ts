import { ensure, parse } from '../../contracts/foundation.ts';
import { Condition, Effect, ScriptOperation, ScriptPlanData, type ScriptNode, type VariableDefinition, type RuleValue, type CommitPhase } from '../../contracts/interactive-script.ts';

export type Variables = Record<string, RuleValue>;
export function valueMatches(definition: VariableDefinition, value: unknown): value is RuleValue {
  switch (definition.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && definition.values.includes(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value) && value >= definition.min && value <= definition.max;
    case 'text': return typeof value === 'string' && value.length <= definition.maxLength;
  }
}
export function initialVariables(definitions: readonly VariableDefinition[]): Variables {
  const variables: Variables = {};
  for (const definition of definitions) {
    ensure(!Object.hasOwn(variables, definition.key), 'VALIDATION', `重复变量 ${definition.key}`);
    ensure(valueMatches(definition, definition.initial), 'VALIDATION', `变量 ${definition.key} 初始值无效`);
    variables[definition.key] = definition.initial;
  }
  return variables;
}
export function validateVariables(definitions: readonly VariableDefinition[], variables: Variables): void {
  const known = new Set(definitions.map(item => item.key));
  for (const key of Object.keys(variables)) ensure(known.has(key), 'VALIDATION', `未声明变量 ${key}`);
  for (const definition of definitions) ensure(Object.hasOwn(variables, definition.key) && valueMatches(definition, variables[definition.key]), 'VALIDATION', `变量 ${definition.key} 缺失或类型/范围不符`);
}
export function conditionVariableKeys(condition: Condition): string[] {
  const parsed = parse(Condition, condition), keys = new Set<string>(), queue = [parsed];
  while (queue.length) {
    const item = queue.pop()!;
    if (item.op === 'all' || item.op === 'any') queue.push(...item.conditions);
    else if (item.op === 'not') queue.push(item.condition);
    else keys.add(item.key);
  }
  return [...keys];
}
/** Include semantic reads even for an older release whose reads declaration was incomplete. */
export function segmentVariableKeys(node: Extract<ScriptNode, { type: 'segment' }>): string[] {
  const content = node.contentSpec;
  if (content.mode === 'fixed') return [];
  const contract = content.generationContract;
  const keys = new Set(contract?.reads ?? []);
  if (content.mode === 'template') {
    content.reads.forEach(key => keys.add(key));
    for (const match of content.text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) keys.add(match[1]!);
    content.variants.forEach(variant => conditionVariableKeys(variant.when).forEach(key => keys.add(key)));
  }
  if (contract) {
    const conditions = [...contract.entryConditions, ...contract.outcomeCases.map(item => item.when), ...contract.outcomes.flatMap(item => item.postconditions), ...contract.boundFallbacks.flatMap(item=>item.entryConditions)];
    conditions.forEach(condition => conditionVariableKeys(condition).forEach(key => keys.add(key)));
    // Increment bounds and outcome postconditions are checked before dispatch.
    contract.outcomes.flatMap(item => item.completionEffects).filter(effect => effect.op === 'increment').forEach(effect => keys.add(effect.key));
  }
  return [...keys].sort();
}
export function assertCondition(condition: Condition, definitions: readonly VariableDefinition[]): Condition {
  const parsed = parse(Condition, condition), byKey = new Map(definitions.map(item => [item.key, item])), queue = [parsed];
  while (queue.length) {
    const item = queue.pop()!;
    if (item.op === 'all' || item.op === 'any') { queue.push(...item.conditions); continue; }
    if (item.op === 'not') { queue.push(item.condition); continue; }
    const definition = byKey.get(item.key);
    ensure(definition, 'VALIDATION', `条件引用未声明变量 ${item.key}`);
    ensure(definition.type !== 'text', 'VALIDATION', `文本变量 ${item.key} 不能直接用于分路条件`);
    if (item.op === 'gte' || item.op === 'lte') ensure(definition.type === 'integer', 'VALIDATION', `条件 ${item.op} 需要整数变量 ${item.key}`);
    const values = item.op === 'in' ? item.values : [item.value];
    for (const value of values) ensure(valueMatches(definition, value), 'VALIDATION', `条件 ${item.key} 的比较值类型或范围不符`);
  }
  return parsed;
}
export function evaluateCondition(condition: Condition, variables: Variables, definitions: readonly VariableDefinition[]): boolean {
  const parsed = assertCondition(condition, definitions);
  validateVariables(definitions, variables);
  const evaluate = (item: Condition): boolean => {
    switch (item.op) {
      case 'eq': return variables[item.key] === item.value;
      case 'in': return item.values.includes(variables[item.key]!);
      case 'gte': return (variables[item.key] as number) >= item.value;
      case 'lte': return (variables[item.key] as number) <= item.value;
      case 'all': return item.conditions.every(evaluate);
      case 'any': return item.conditions.some(evaluate);
      case 'not': return !evaluate(item.condition);
    }
  };
  return evaluate(parsed);
}
export function selectBranch(node: Extract<ScriptNode, { type: 'branch' }>, variables: Variables, definitions: readonly VariableDefinition[]): { caseId: string; to: string; fallback: boolean } {
  ensure(new Set(node.cases.map(item => item.priority)).size === node.cases.length, 'VALIDATION', '分支优先级必须唯一');
  for (const item of node.cases) assertCondition(item.when, definitions);
  const selected = [...node.cases].sort((a, b) => a.priority - b.priority).find(item => evaluateCondition(item.when, variables, definitions));
  return selected ? { caseId: selected.id, to: selected.to, fallback: false } : { caseId: node.fallback.id, to: node.fallback.to, fallback: true };
}
export type EffectContext = { sourceId: string; phase: CommitPhase; result?: Record<string, RuleValue> };
export function applyEffects(definitions: readonly VariableDefinition[], variables: Variables, effects: readonly Effect[], context: EffectContext): Variables {
  validateVariables(definitions, variables);
  const output = { ...variables }, byKey = new Map(definitions.map(item => [item.key, item]));
  const identities = new Set<string>();
  for (const raw of effects) {
    const effect = parse(Effect, raw);
    ensure(!identities.has(effect.id), 'VALIDATION', `重复效果 ${effect.id}`); identities.add(effect.id);
    ensure(effect.commitAt === context.phase, 'VALIDATION', `效果 ${effect.id} 提交阶段不匹配`);
    const definition = byKey.get(effect.key);
    ensure(definition, 'VALIDATION', `效果引用未声明变量 ${effect.key}`);
    ensure(definition.allowedWriters.some(writer => writer.sourceId === context.sourceId && writer.commitAt === context.phase), 'FORBIDDEN', `节点无权写入变量 ${effect.key}`);
    if (effect.op === 'unsetSegment') {
      ensure(definition.scope === 'segment', 'VALIDATION', `不能清理 run 变量 ${effect.key}`);
      output[effect.key] = definition.initial;
      continue;
    }
    const value = effect.value.source === 'constant' ? effect.value.value : context.result && Object.hasOwn(context.result, effect.value.field) ? context.result[effect.value.field] : undefined;
    ensure(value !== undefined, 'VALIDATION', `效果结果字段缺失 ${effect.key}`);
    if (effect.op === 'increment') {
      ensure(definition.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value), 'VALIDATION', 'increment 只接受整数变量与整数增量');
      const next = (output[effect.key] as number) + value;
      ensure(valueMatches(definition, next), 'VALIDATION', `变量 ${effect.key} 效果越界`);
      output[effect.key] = next;
    } else {
      ensure(valueMatches(definition, value), 'VALIDATION', `变量 ${effect.key} 效果类型或范围不符`);
      output[effect.key] = value;
    }
  }
  return output;
}
export function resetSegmentVariables(definitions: readonly VariableDefinition[], variables: Variables): Variables {
  validateVariables(definitions, variables);
  return Object.fromEntries(definitions.map(item => [item.key, item.scope === 'segment' ? item.initial : variables[item.key]! ]));
}
export function applyScriptOperations(plan: ScriptPlanData, operations: readonly ScriptOperation[]): ScriptPlanData {
  const next = structuredClone(parse(ScriptPlanData, plan));
  for (const raw of operations) {
    const operation = parse(ScriptOperation, raw);
    const upsert = <T>(items: T[], value: T, matches: (item: T) => boolean) => { const index = items.findIndex(matches); if (index < 0) items.push(value); else items[index] = value; };
    switch (operation.op) {
      case 'title.set': next.title = operation.title; break;
      case 'entry.set': next.entryNodeId = operation.nodeId; break;
      case 'chapter.order': next.chapterRefs = operation.chapterRefs; break;
      case 'policy.set': next.policy = operation.policy; break;
      case 'node.insert': ensure(!next.nodes.some(node => node.id === operation.node.id), 'CONFLICT', '节点已存在'); next.nodes.push(operation.node); break;
      case 'node.replace': ensure(next.nodes.some(node => node.id === operation.node.id), 'NOT_FOUND', '节点不存在'); upsert(next.nodes, operation.node, node => node.id === operation.node.id); break;
      case 'node.remove': ensure(next.nodes.some(node => node.id === operation.nodeId), 'NOT_FOUND', '节点不存在'); next.nodes = next.nodes.filter(node => node.id !== operation.nodeId); break;
      case 'branch.case.upsert': case 'branch.case.remove': {
        const node = next.nodes.find(node => node.id === operation.nodeId);
        ensure(node?.type === 'branch', 'VALIDATION', '目标不是分支节点');
        if (operation.op === 'branch.case.upsert') upsert(node.cases, operation.branchCase, item => item.id === operation.branchCase.id);
        else { ensure(node.cases.some(item => item.id === operation.caseId), 'NOT_FOUND', '分支条件不存在'); node.cases = node.cases.filter(item => item.id !== operation.caseId); }
        break;
      }
      case 'variable.upsert': upsert(next.variables, operation.variable, item => item.key === operation.variable.key); break;
      case 'variable.remove': ensure(next.variables.some(item => item.key === operation.key), 'NOT_FOUND', '变量不存在'); next.variables = next.variables.filter(item => item.key !== operation.key); break;
      case 'activity.upsert': upsert(next.activities, operation.activity, item => item.id === operation.activity.id); break;
      case 'activity.remove': ensure(next.activities.some(item => item.id === operation.activityId), 'NOT_FOUND', '活动不存在'); next.activities = next.activities.filter(item => item.id !== operation.activityId); break;
      case 'cue.upsert': upsert(next.cues, operation.cue, item => item.id === operation.cue.id); break;
      case 'cue.remove': ensure(next.cues.some(item => item.id === operation.cueId), 'NOT_FOUND', 'Cue 不存在'); next.cues = next.cues.filter(item => item.id !== operation.cueId); break;
      case 'source.rebind': { const node = next.nodes.find(node => node.id === operation.nodeId); ensure(node?.type === 'segment', 'VALIDATION', '来源只能绑定到片段节点'); node.chapterId = operation.chapterId; node.sourceSceneRefs = operation.sourceSceneRefs; break; }
    }
  }
  return parse(ScriptPlanData, next);
}
