import {z} from 'zod';
import {Id} from './foundation.ts';

export const NovelExportRequest=z.strictObject({
  projectId:Id,requestId:Id,
  // Zero exports one file. Positive values are targets; chapters stay intact.
  maxCharacters:z.number().int().min(0).max(10_000_000).default(0),
});
export type NovelExportRequest=z.infer<typeof NovelExportRequest>;
export const NovelExportResult=z.object({
  id:Id,projectId:Id,title:z.string(),directory:z.string(),createdAt:z.string(),
  chapterCount:z.number(),skippedEmptyCount:z.number(),totalCharacters:z.number(),maxCharacters:z.number(),
  files:z.array(z.object({
    name:z.string(),characters:z.number(),chapterCount:z.number(),firstNumber:z.number(),lastNumber:z.number(),
    oversized:z.boolean(),downloadUrl:z.string(),
  })),
});
export type NovelExportResult=z.infer<typeof NovelExportResult>;
