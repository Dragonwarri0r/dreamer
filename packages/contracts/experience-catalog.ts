import { z } from 'zod';
import { Id } from './foundation.ts';

export const ExperienceCatalogQuery = z.strictObject({ cursor: Id.optional(), limit: z.number().int().min(1).max(100).default(30) });
export const ExperienceCatalogRelease = z.strictObject({
  releaseId: Id, scriptId: Id, scriptVersion: z.number().int().positive().safe(), scriptTitle: z.string(), publishedAt: z.string().datetime(),
  hasDynamicContent: z.boolean(), mayWaitForPreparation: z.boolean(), requiresAuthorReview: z.boolean(),
  limits: z.strictObject({ maxTextCallsPerRun: z.number().int().nonnegative(), maxMediaJobsPerRun: z.number().int().nonnegative() }),
  budgetHint: z.string(),
});
export type ExperienceCatalogRelease = z.infer<typeof ExperienceCatalogRelease>;
/** Viewer-safe metadata only. Snapshot, source references and private state are intentionally absent. */
export const ExperienceCatalog = z.strictObject({ releases: z.array(ExperienceCatalogRelease).max(100), nextCursor: Id.optional() });
export type ExperienceCatalog = z.infer<typeof ExperienceCatalog>;
