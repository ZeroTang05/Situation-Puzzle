import type { TextareaHTMLAttributes } from 'react';

/** 单人和多人共用单行高度的输入框，长文本仍可在框内滚动。 */
export function ChatInput(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'className'>) {
  return <textarea {...props} className="field composer-input" rows={1} />;
}
