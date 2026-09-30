/** 等待室选题入口直接展示已确认的题名，仍可点击重新选择。 */
import { useLanguage } from '../state/language.js';

export function PuzzleSelection({ title, href }: { title: string | null; href: string }) {
  const { copy } = useLanguage();
  return <a className="btn puzzle-selection" href={href}>
    {title ? <><small>{copy.currentPuzzle}</small><strong>{title}</strong><small>{copy.selectAgain}</small></> : copy.selectPuzzle}
  </a>;
}
