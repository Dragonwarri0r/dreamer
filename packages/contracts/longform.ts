import {z} from 'zod';
import {Id,Ref} from './foundation.ts';

export const ChapterData=z.strictObject({
  title:z.string().trim().min(1).max(160),
  number:z.number().int().min(1).max(1000000),
  volume:z.string().max(160).default('第一卷'),
  synopsis:z.string().max(6000).default(''),
  body:z.string().max(200000).default(''),
  status:z.enum(['outline','draft','review','done']).default('outline'),
  tags:z.array(z.string().max(60)).max(30).default([]),
  notes:z.string().max(6000).default(''),
  branchOf:Ref.optional(),
});
export type ChapterData=z.infer<typeof ChapterData>;
export const EpisodeData=z.strictObject({
  title:z.string().trim().min(1).max(160),
  chapterIds:z.array(Id).max(100).default([]),
  shotIds:z.array(Id).max(500).default([]),
  shotFrames:z.record(Id,z.number().int().min(1).max(144000)).default({}),
  targetSeconds:z.number().int().min(1).max(3600).default(120),
  brief:z.string().max(6000).default(''),
  status:z.enum(['planning','boarding','producing','review','done']).default('planning'),
  branchOf:Ref.optional(),
});
export type EpisodeData=z.infer<typeof EpisodeData>;
export const SearchQuery=z.strictObject({
  kind:z.enum(['all','chapter','scene','shot','resource','knowledge','episode','script']).default('all'),
  query:z.string().max(200).default(''),
  chapterId:Id.optional(),
  episodeId:Id.optional(),
  volume:z.string().max(160).optional(),
  status:z.string().max(40).optional(),
  offset:z.number().int().min(0).max(1000000).default(0),
  limit:z.number().int().min(1).max(50).default(30),
});
export type SearchQuery=z.infer<typeof SearchQuery>;
export type SearchResult={items:any[];total:number;offset:number;limit:number;nextOffset:number|null};
export type Discovery={
  search:(pid:string,query:SearchQuery)=>SearchResult;
  catalog:(pid:string,kind:string)=>any[];
};
