/**
 * 赞/踩图标：矢量三角，替代 emoji。
 * emoji 在不同系统会渲染成彩色表情，和深海冷色系不协调，矢量图标尺寸也更可控。
 */
export function VoteIcon({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      className={`vote-icon vote-icon-${direction}`}
      viewBox="0 0 16 16"
      width="11"
      height="11"
      aria-hidden="true"
      focusable="false"
    >
      <path d={direction === 'up' ? 'M8 2.6 14.4 11.4H1.6z' : 'M8 13.4 1.6 4.6h12.8z'} fill="currentColor" />
    </svg>
  );
}
