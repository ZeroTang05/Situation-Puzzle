-- 全部表结构合并为一份初始化迁移；初始题库不在这里播种。
-- worker 每次启动读取 data/library.json，整体覆盖 id 以 seed- 开头的行。
-- 产品不做用户体系：访客进度保存在各自浏览器的 localStorage，服务端只存题目与审核记录。

-- 海龟汤题目；新投稿经 Jev 二元审核通过即 'published'，未通过为 'rejected'，管理员仍可复核下架。
-- reviewed_at 记录管理员最后一次复核时间，未复核为 NULL。
CREATE TABLE soups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  story TEXT NOT NULL,
  answer TEXT NOT NULL,
  hints TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '匿名玩家',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'deleted')),
  language TEXT NOT NULL DEFAULT 'zh' CHECK (language IN ('zh', 'en')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  reviewed_at TEXT,
  moderation_note TEXT,
  creator_token TEXT NOT NULL DEFAULT ''
);

CREATE INDEX soups_public_feed ON soups(status, published_at DESC);
CREATE INDEX soups_moderation_queue ON soups(status, created_at ASC);
CREATE INDEX soups_review_queue ON soups(status, reviewed_at, created_at);

-- 管理动作独立保存，方便追查谁在何时发布、驳回或删除题目。
CREATE TABLE moderation_logs (
  id TEXT PRIMARY KEY,
  soup_id TEXT NOT NULL REFERENCES soups(id),
  action TEXT NOT NULL CHECK (action IN ('published', 'rejected', 'deleted')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
