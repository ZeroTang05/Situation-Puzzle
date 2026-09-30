/** 游玩页共用顶部栏：等宽两侧保持题目居中，操作按钮各自贴边。 */
import type { ReactNode } from 'react';

export function GameHeader({ title, back, action }: { title: string; back: ReactNode; action?: ReactNode }) {
  return (
    <header className="topbar game-topbar">
      <div className="game-topbar-back">{back}</div>
      <h1 className="brand brand-sm" title={title}>{title}</h1>
      <div className="game-topbar-action">{action}</div>
    </header>
  );
}
