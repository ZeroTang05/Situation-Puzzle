-- 全部表结构合并为一份初始化迁移；初始题库不在这里播种。
-- worker 每次启动读取 data/library.json，整体覆盖 id 以 seed- 开头的行。

-- 产品用户：每个通过平台 OpenID 验证的玩家对应一行；网页访客不写入此表。
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 平台身份：每个 (platform, open_id) 唯一对应一个 user；用户可关联多个平台。
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('bilibili', 'xiaohongshu')),
  platform_open_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_open_id)
);

-- 平台用户会话令牌；网页访客不发 Authorization 头，不会被记录。
CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
  creator_token TEXT NOT NULL DEFAULT '',
  author_user_id TEXT REFERENCES users(id)
);

CREATE INDEX soups_public_feed ON soups(status, published_at DESC);
CREATE INDEX soups_moderation_queue ON soups(status, created_at ASC);
CREATE INDEX soups_review_queue ON soups(status, reviewed_at, created_at);
CREATE INDEX identities_user ON user_identities(user_id);
CREATE INDEX soups_author ON soups(author_user_id, created_at DESC);

-- 管理动作独立保存，方便追查谁在何时发布、驳回或删除题目。
CREATE TABLE moderation_logs (
  id TEXT PRIMARY KEY,
  soup_id TEXT NOT NULL REFERENCES soups(id),
  action TEXT NOT NULL CHECK (action IN ('published', 'rejected', 'deleted')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 仅可识别的平台用户保存个人进度；网页访客不写入此表。
-- soup_id 不设外键：内置题库重新播种时会替换题目行，进度按稳定题目 ID 保留。
CREATE TABLE soup_progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  soup_id TEXT NOT NULL,
  first_played_at TEXT NOT NULL,
  last_played_at TEXT NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT,
  solved_at TEXT,
  PRIMARY KEY (user_id, soup_id)
);

CREATE INDEX soup_progress_user_solved ON soup_progress(user_id, solved_at);