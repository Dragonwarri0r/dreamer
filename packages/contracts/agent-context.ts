import {z} from 'zod';
import {Id,Ref} from './foundation.ts';

export const Binding=z.strictObject({ref:Ref,purpose:z.string().max(200).default('参考'),layer:z.enum(['project','work','thread','turn']).default('turn'),selection:z.strictObject({blockId:Id.optional(),field:z.enum(['body','text']).optional(),from:z.number().int().nonnegative(),to:z.number().int().nonnegative(),text:z.string().max(10000)}).optional()});
