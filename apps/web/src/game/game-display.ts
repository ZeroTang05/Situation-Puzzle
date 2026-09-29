/** 游玩界面的公开数据格式化，供房间和单人共用。 */
import { confidenceLabel as i18nConfidenceLabel, type Language } from '@jev/i18n';

export function inviteUrl(origin: string, token: string): string {
  return new URL(`/invite/${encodeURIComponent(token)}`, origin).href;
}

/** 原样展示模型概率，不用默认值补出置信度。 */
export function confidenceLabel(value: number | null | undefined, language: Language): string | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('置信度必须在 0 到 1 之间');
  return i18nConfidenceLabel(value, language);
}