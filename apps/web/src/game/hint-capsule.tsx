/**
 * 已解锁提示的悬浮胶囊：固定定位不占布局，10 秒无操作自动收起。
 * 打开/翻页由页面上的提示按钮驱动（useHintPlayer.cycle 循环翻阅），
 * 胶囊内的箭头也可手动翻阅（同样重置倒计时）；解锁新提示用 show 定位到它。
 */
import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../state/language.js';

const AUTO_CLOSE_MS = 10_000;

/** 提示播放器：open/index 受控状态 + 10 秒自动收起计时。 */
export function useHintPlayer(hints: string[]) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  // 打开或翻页都会重置倒计时；手动翻阅长提示时不会被中途收起
  useEffect(() => {
    if (!open) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer.current);
  }, [open, index]);

  /** 打开并定位到指定条（解锁新提示后展示它；索引越界由胶囊渲染时收敛）。
   *  不判 hints 空：解锁回调里的 hints 是旧渲染闭包（首次为空，判空会把首次弹出吞掉），
   *  解锁引发的列表更新与 open 更新同批渲染；空列表时渲染层兜底不显示。 */
  const show = (at: number) => {
    setOpen(true);
    setIndex(Math.max(0, at));
  };

  /** 提示按钮点击：已打开则循环下一条（最后一条回到第一条），收起状态则从头播放 */
  const cycle = () => {
    if (!hints.length) return;
    setOpen(true);
    setIndex((i) => (open ? (i + 1) % hints.length : 0));
  };

  return { open, index, show, cycle };
}

export function HintCapsule({ hints, total = 3, open, index, onIndex }: {
  hints: string[];
  total?: number;
  open: boolean;
  index: number;
  onIndex: (i: number) => void;
}) {
  const { copy } = useLanguage();
  if (!open || !hints.length) return null;
  // 索引可能暂时指向尚未到达的新提示（解锁命令刚发出），渲染时收敛到最后一条
  const current = Math.min(index, hints.length - 1);
  return <section className="hint-capsule" role="status" aria-label={copy.hint}>
    <div className="hint-capsule-head">
      <strong><span className="hint-icon" aria-hidden>💡</span> {copy.hint} {current + 1}/{total}</strong>
      <div className="hint-capsule-nav">
        <button className="btn btn-sm btn-ghost" aria-label={copy.hintPrev} onClick={() => onIndex((current - 1 + hints.length) % hints.length)}>←</button>
        <button className="btn btn-sm btn-ghost" aria-label={copy.hintNext} onClick={() => onIndex((current + 1) % hints.length)}>→</button>
      </div>
    </div>
    <p>{hints[current]}</p>
  </section>;
}
