/** 语言版本共用发布版号，仍要求每个语言版本通过发布审核。 */
import { and, eq, sql } from 'drizzle-orm';
import { puzzles, puzzleVersions } from '@jev/database';

export function publishedLanguageJoin() {
  return and(
    eq(puzzleVersions.puzzleId, puzzles.id),
    eq(puzzleVersions.moderationStatus, 'published'),
    sql`${puzzleVersions.versionNo} = (select published.version_no from puzzle_versions published where published.id = ${puzzles.currentPublishedVersionId})`,
  );
}
