/**
 * 游玩界面的公开数据格式化（口径对齐 apps/web/src/game/game-display.ts）。
 * 原样展示模型概率，不用默认值补出置信度。
 */
import { confidenceLabel as i18nConfidenceLabel, type Language } from '@jev/i18n'

export function confidenceLabel(value: number | null | undefined, language: Language): string | null {
  if (value == null) return null
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('置信度必须在 0 到 1 之间')
  return i18nConfidenceLabel(value, language)
}

/** 题库卡片的紧凑票数；千位以上保留一位小数并向下取整。（与 web 端相同） */
export function compactVoteCount(count: number): string {
  if (count < 1000) return String(count)
  const thousands = Math.floor(count / 100) / 10
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`
}
