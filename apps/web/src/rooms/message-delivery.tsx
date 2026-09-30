/** 正常发送不加状态文字，只展示明确失败或需要继续确认的异常。 */
import { format } from '@jev/i18n';
import { useLanguage } from '../state/language.js';
import type { PendingCommand } from './room-local.js';

export function MessageDelivery({ status, error }: { status: PendingCommand['status']; error?: string }) {
  const { copy } = useLanguage();
  if (status === 'sent' || status === 'sending') return null;
  return <p className={status === 'rejected' ? 'error-text' : 'muted'} role="status">
    {status === 'confirming' ? copy.confirming : format(copy.notSent, { n: error ?? '' })}
  </p>;
}
