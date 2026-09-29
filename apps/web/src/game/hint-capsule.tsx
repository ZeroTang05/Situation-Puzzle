/** 已解锁提示的翻阅胶囊；新增提示后自动展示最新一条。 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../state/language.js';

export function HintCapsule({ hints, total = 3 }: { hints: string[]; total?: number }) {
  const { copy, language } = useLanguage();
  const [index, setIndex] = useState(Math.max(0, hints.length - 1));
  useEffect(() => setIndex(Math.max(0, hints.length - 1)), [hints.length]);
  if (!hints.length) return null;
  const current = Math.min(index, hints.length - 1);
  return <section className="hint-capsule" aria-label={copy.hint} aria-live="polite">
    <div className="hint-capsule-head">
      <strong>💡 {copy.hint} {current + 1}/{total}</strong>
      <div>
        <button className="btn btn-sm btn-ghost" aria-label={copy.hintPrev} disabled={current === 0} onClick={() => setIndex(current - 1)}>←</button>
        <button className="btn btn-sm btn-ghost" aria-label={copy.hintNext} disabled={current === hints.length - 1} onClick={() => setIndex(current + 1)}>→</button>
      </div>
    </div>
    <p>{hints[current]}</p>
  </section>;
}