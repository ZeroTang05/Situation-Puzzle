/**
 * 汤面卡片：题面可滚动，外层只负责高度约束（不加遮罩或阴影，避免干扰阅读）。
 */
import type { ReactNode } from 'react';

export function StoryCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="story-wrap">
      <section className={`story-card game-scroll${className ? ` ${className}` : ''}`}>{children}</section>
    </div>
  );
}
