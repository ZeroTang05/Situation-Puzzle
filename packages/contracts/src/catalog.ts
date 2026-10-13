/** 题库列表查询：页码用于直接选页，游标用于连续读取。 */
import { z } from 'zod';
import { difficultySchema, languageSchema, puzzleCategorySchema } from './http.js';

export const catalogListQuerySchema = z.object({
  language: languageSchema.default('zh'),
  difficulty: difficultySchema.optional(),
  category: puzzleCategorySchema.optional(),
  sort: z.enum(['latest', 'popular']).default('latest'),
  cursor: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).refine((query) => query.page === undefined || query.cursor === undefined, {
  message: '页码与游标不能同时使用', path: ['page'],
});
