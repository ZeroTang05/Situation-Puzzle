-- 新投稿先公开，再由管理员复核；旧的待审核投稿也转入公开待复核队列。
ALTER TABLE soups ADD COLUMN reviewed_at TEXT;

-- 之前已由管理员发布的玩家题目视为完成复核。
UPDATE soups
SET reviewed_at = COALESCE(published_at, created_at)
WHERE status = 'published' AND creator_token <> 'seed';

UPDATE soups
SET status = 'published', published_at = COALESCE(published_at, created_at)
WHERE status = 'pending';

CREATE INDEX soups_review_queue ON soups(status, reviewed_at, created_at);
