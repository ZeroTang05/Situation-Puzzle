-- 增加人工复核时间；历史待审核投稿继续保持隐藏，由管理员逐篇处理。
ALTER TABLE soups ADD COLUMN reviewed_at TEXT;

-- 之前已由管理员发布的玩家题目视为完成复核。
UPDATE soups
SET reviewed_at = COALESCE(published_at, created_at)
WHERE status = 'published' AND creator_token <> 'seed';

CREATE INDEX soups_review_queue ON soups(status, reviewed_at, created_at);
