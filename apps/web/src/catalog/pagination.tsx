/** 题库页码栏：首尾页常驻，中间页围绕当前页展开。 */
import { useLanguage } from '../state/language.js';

/** 最多展示七个位置，小屏也能保留完整的当前页上下文。 */
export function paginationItems(page: number, totalPages: number): (number | 'ellipsis')[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, 'ellipsis', totalPages];
  if (page >= totalPages - 3) return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages];
}

export function CatalogPagination({ page, totalPages, total, busy, onPage }: {
  page: number; totalPages: number; total: number; busy: boolean; onPage: (page: number) => void;
}) {
  const { language, copy } = useLanguage();
  return (
    <nav className="library-pagination" aria-label={copy.libraryPagination} aria-busy={busy}>
      <p className="library-pagination-summary" aria-live="polite">
        {language === 'zh' ? `共 ${total} 题 · 第 ${page} / ${totalPages} 页` : `${total} puzzles · Page ${page} of ${totalPages}`}
      </p>
      <div className="library-pagination-controls">
        <button type="button" className="library-page-step" disabled={busy || page <= 1} onClick={() => onPage(page - 1)} aria-label={copy.previousPage}>‹</button>
        <div className="library-page-numbers">
          {paginationItems(page, totalPages).map((item, index) => item === 'ellipsis'
            ? <span className="library-page-ellipsis" key={`gap-${index}`} aria-hidden="true">…</span>
            : <button type="button" className="library-page-number" key={item} aria-current={item === page ? 'page' : undefined}
                aria-label={language === 'zh' ? `第 ${item} 页` : `Page ${item}`} disabled={busy || item === page} onClick={() => onPage(item)}>{item}</button>)}
        </div>
        <button type="button" className="library-page-step" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)} aria-label={copy.nextPage}>›</button>
      </div>
    </nav>
  );
}
