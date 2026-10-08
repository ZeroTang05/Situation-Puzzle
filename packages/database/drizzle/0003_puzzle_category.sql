-- 题目类别：本格（honkaku，汤底须现实合理）/ 变格（henkaku，允许超自然设定）。
-- 存量版本（旧题库、既有投稿）没有类别，保持 NULL；筛选默认全部。
-- 详见 packages/database/src/schema/content.ts puzzleCategoryEnum 定义。

CREATE TYPE "puzzle_category" AS ENUM ('honkaku', 'henkaku');
ALTER TABLE "puzzle_versions" ADD COLUMN "category" "puzzle_category";
