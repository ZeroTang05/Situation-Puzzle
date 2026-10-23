/**
 * 项目备份契约：数据库快照存进 S3 兼容对象存储，后台可备份 / 还原 / 删除。
 *
 * 备份文件是 gzip 压缩的 JSON（见 apps/api/src/backup/archive.ts），
 * 接口只回传元信息，不把备份内容塞进响应体。
 */
import { z } from 'zod';

/** 对象存储配置状态：未配置时后台只显示「未接入」，不提供备份入口。 */
export const backupStorageStatusSchema = z.object({
  configured: z.boolean(),
  bucket: z.string().nullable(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  /** 备份文件在桶内的前缀 */
  prefix: z.string(),
});

/** 桶里的一个备份对象 */
export const backupObjectSchema = z.object({
  /** 桶内 key（含前缀），还原 / 删除都按它定位 */
  key: z.string(),
  /** 字节数 */
  size: z.number().int().nonnegative(),
  /** 对象最后修改时间（ISO） */
  lastModified: z.string(),
  /** 备份生成时间（ISO；从 key 解析，解析不出时回落到最后修改时间） */
  createdAt: z.string(),
});

export const backupListResponseSchema = z.object({
  storage: backupStorageStatusSchema,
  items: z.array(backupObjectSchema),
});

/** 备份结果摘要 */
export const backupCreateResponseSchema = z.object({
  key: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string(),
  tableCount: z.number().int(),
  rowCount: z.number().int(),
});

/**
 * 还原请求：必须显式带确认口令。
 * 还原会覆盖当前数据库全部业务数据，属于不可逆操作，服务端强制二次确认。
 */
export const backupRestoreRequestSchema = z.object({
  key: z.string().min(1).max(512),
  /** 固定口令 RESTORE */
  confirm: z.literal('RESTORE'),
  /** 操作理由：审计留痕用 */
  reason: z.string().min(2).max(500),
});

/** 创建备份的请求体：只有操作理由 */
export const backupCreateRequestSchema = z.object({
  reason: z.string().min(2).max(500),
});

/** 删除备份文件的请求体 */
export const backupDeleteRequestSchema = z.object({
  key: z.string().min(1).max(512),
  reason: z.string().min(2).max(500),
});

export const backupRestoreResponseSchema = z.object({
  key: z.string(),
  tableCount: z.number().int(),
  rowCount: z.number().int(),
  restoredAt: z.string(),
});

export type BackupStorageStatus = z.infer<typeof backupStorageStatusSchema>;
export type BackupObject = z.infer<typeof backupObjectSchema>;
export type BackupCreateResponse = z.infer<typeof backupCreateResponseSchema>;
export type BackupRestoreResponse = z.infer<typeof backupRestoreResponseSchema>;
