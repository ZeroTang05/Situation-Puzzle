-- 全部表结构合并为一份初始化迁移；初始题库不在这里播种。
-- worker 每次启动读取 data/library.json，整体覆盖 id 以 seed- 开头的行。

-- 平台身份与产品用户分离：一个用户可关联多个平台身份。
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK (platform IN ('anonymous', 'bilibili', 'xiaohongshu')),
  platform_open_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(platform, platform_open_id)
);

CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 用户可创建海龟汤；公开题必须由管理员审核并发布；hints 存三条提示的 JSON 数组。
CREATE TABLE soups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  story TEXT NOT NULL,
  answer TEXT NOT NULL,
  hints TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '匿名玩家',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  moderation_note TEXT,
  creator_token TEXT NOT NULL DEFAULT '',
  author_user_id TEXT REFERENCES users(id)
);

CREATE INDEX soups_public_feed ON soups(status, published_at DESC);
CREATE INDEX soups_moderation_queue ON soups(status, created_at ASC);
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
