import { ensure, Id, parse } from '../../contracts/foundation.ts';
import type { ScriptRelease } from '../../contracts/experience.ts';
import { ExperienceCatalog, ExperienceCatalogQuery, type ExperienceCatalogRelease } from '../../contracts/experience-catalog.ts';
import type { ExperiencePersistence } from './ports.ts';

/** Read-only projection: publishing a release never grants a new run generation authority. */
export function experienceCatalog(store: ExperiencePersistence, projectId: string, rawQuery: unknown = {}): ExperienceCatalog {
  const pid = parse(Id, projectId), query = parse(ExperienceCatalogQuery, rawQuery);
  const releases = store.list<ScriptRelease>('releases', { projectId: pid }).map(row => row.data)
    .filter(release => release.kind === 'playback' && release.publishedAt)
    .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!) || a.id.localeCompare(b.id));
  const cursorIndex = query.cursor ? releases.findIndex(release => release.id === query.cursor) : -1;
  ensure(!query.cursor || cursorIndex >= 0, 'NOT_FOUND', '已发布体验目录的游标不存在');
  const offset = cursorIndex + 1, page = releases.slice(offset, offset + query.limit);
  return parse(ExperienceCatalog, { releases: page.map(summary), ...(offset + page.length < releases.length ? { nextCursor: page.at(-1)!.id } : {}) });
}

function summary(release: ScriptRelease): ExperienceCatalogRelease {
  const segments = release.snapshot.nodes.filter(node => node.type === 'segment');
  const generatedContent = segments.some(node => node.contentSpec.mode === 'generated' || (node.contentSpec.mode === 'template' && node.contentSpec.generationContract !== undefined));
  const interpretsInput = release.snapshot.activities.some(activity => activity.type === 'text-intent');
  const limits = { maxTextCallsPerRun: release.policy.maxTextCallsPerRun, maxMediaJobsPerRun: release.policy.maxMediaJobsPerRun };
  return {
    releaseId: release.id, scriptId: release.scriptRef.id, scriptVersion: release.scriptRef.seq, scriptTitle: release.snapshot.title, publishedAt: release.publishedAt!,
    hasDynamicContent: segments.some(node => node.contentSpec.mode !== 'fixed') || interpretsInput,
    mayWaitForPreparation: generatedContent || interpretsInput,
    requiresAuthorReview: generatedContent && release.policy.reviewMode === 'authorReview', limits,
    budgetHint: generatedContent || interpretsInput
      ? `每次体验最多 ${limits.maxTextCallsPerRun} 次文本调用、${limits.maxMediaJobsPerRun} 个媒体任务；实际执行仍受发布授权、当前服务和项目剩余额度约束。`
      : '此发布版本使用已有内容，无需为故事调用生成服务。',
  };
}
