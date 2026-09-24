-- 仅可识别的平台用户保存个人进度；网页共享访客不写入此表。
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
