-- 玩家投稿记录原文语言；已有投稿保持中文。
ALTER TABLE soups ADD COLUMN language TEXT NOT NULL DEFAULT 'zh' CHECK (language IN ('zh', 'en'));
