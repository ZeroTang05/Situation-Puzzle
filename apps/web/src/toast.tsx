/**
 * 悬浮反馈条：浮在页面最上层，不占布局，短时间内自动消失。
 * 用于「邀请链接已复制」「操作失败」这类一次性提示。
 */
import { useEffect } from 'react';

export function Toast({ message, tone = 'info', durationMs = 2000, onDone }: { message: string; tone?: 'info' | 'error'; durationMs?: number; onDone?: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => onDone?.(), durationMs);
    return () => clearTimeout(timer);
  }, [message, durationMs, onDone]);

  if (!message) return null;
  return (
    <div className={`toast${tone === 'error' ? ' toast-error' : ''}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}
