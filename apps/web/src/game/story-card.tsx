/**
 * 汤面卡片：题面可滚动时底部渐隐提示，滚到底后渐隐自动消失。
 * 只做视觉提示，不影响题面内容的滚动与选择。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function StoryCard({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      setFaded(remaining > 4);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={`story-wrap${faded ? ' is-faded' : ''}`}>
      <section ref={ref} className={`story-card game-scroll${className ? ` ${className}` : ''}`}>
        {children}
      </section>
    </div>
  );
}
