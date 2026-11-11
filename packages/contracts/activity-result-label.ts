import { ChoiceActivity, TextIntentActivity, type ActivityDefinition, type ActivityAttempt } from './activities.ts';

/** Display only a completed, known result from the frozen activity descriptor. */
export function activityResultLabel(definition: ActivityDefinition, attempt: Pick<ActivityAttempt, 'status' | 'result'>): string | undefined {
  if (attempt.status === 'skipped') return '已跳过';
  if (attempt.status !== 'completed') return undefined;
  const choice = ChoiceActivity.safeParse(definition);
  if (choice.success) return choice.data.config.options.find(option => option.id === attempt.result?.optionId)?.label;
  const intent = TextIntentActivity.safeParse(definition);
  if (intent.success) return intent.data.config.intents.find(item => item.id === attempt.result?.intentId)?.label;
  return undefined;
}
