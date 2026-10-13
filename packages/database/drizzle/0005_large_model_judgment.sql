-- 保存多人还原提交的模型选择，任务进程按提交时的选择判题。
ALTER TABLE "turns" ADD COLUMN "use_large_model" boolean DEFAULT false NOT NULL;
