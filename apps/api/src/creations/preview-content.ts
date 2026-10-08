/** 私人试题绑定保存时的内容；草稿修改后旧凭证立即失效。 */
import { createHash } from 'node:crypto';

export function previewContentHash(content: { title: string; surface: string; answer: string; hints: string[]; coreFacts: string[]; category?: string | null }): string {
  return createHash('sha256').update(JSON.stringify({ title: content.title, surface: content.surface, answer: content.answer, hints: content.hints, coreFacts: content.coreFacts, category: content.category ?? null })).digest('hex');
}
