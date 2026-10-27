/**
 * 备份服务：逻辑导出 → 对象存储 → 还原，以及审计留痕。
 *
 * 约束：
 *  - 未配置对象存储时整体降级（后台只显示「未接入」），不做任何写操作；
 *  - 备份 / 还原是重操作，同一时刻只允许一个在跑（模块级 running 标志）；
 *  - 写操作全部留审计（action / objectType='backup' / objectId=key / reason）。
 */
import { Injectable, Logger } from '@nestjs/common';
import { auditLogs } from '@jev/database';
import { DomainError } from '@jev/domain';
import type { BackupCreateResponse, BackupObject, BackupRestoreResponse, BackupStorageStatus } from '@jev/contracts';
import { app } from '../context.js';
import { decodeArchive, dumpArchive, encodeArchive, restoreArchive, type BackupArchive } from './archive.js';
import {
  BackupStorage,
  backupKey,
  createdAtFromKey,
  isBackupArchiveKey,
  type BackupStorageOptions,
} from './storage.js';

/** 模块级并发标志：同一时刻只允许一个备份 / 还原任务在跑。 */
let running = false;

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private storage: BackupStorage | null = null;
  private timer: NodeJS.Timeout | null = null;

  /** 对象存储接入状态：未接入时后台只显示「未接入」，不提供备份入口。 */
  status(): BackupStorageStatus {
    const env = app().env;
    const bucket = env?.S3_BUCKET ?? null;
    return {
      configured: Boolean(bucket),
      bucket,
      endpoint: bucket ? (env?.S3_ENDPOINT ?? null) : null,
      region: bucket ? (env?.S3_REGION ?? null) : null,
      prefix: bucket ? (env?.S3_BACKUP_PREFIX ?? null) : null,
    };
  }

  /** 备份列表：新的在前；未接入时返回空列表。 */
  async list(): Promise<{ storage: BackupStorageStatus; items: BackupObject[] }> {
    const storage = this.status();
    if (!storage.configured) return { storage, items: [] };
    const objects = await this.client().listBackups(this.prefix());
    return {
      storage,
      items: objects.map((object) => ({
        key: object.key,
        size: object.size,
        lastModified: object.lastModified,
        createdAt: createdAtFromKey(object.key) ?? object.lastModified,
      })),
    };
  }

  /** 创建备份：导出 → gzip → 存入对象存储 → 留审计。 */
  async create(operatorUserId: string | null, reason: string): Promise<BackupCreateResponse> {
    if (!this.status().configured) throw new DomainError('BACKUP_NOT_CONFIGURED', '未接入对象存储，无法创建备份');
    const prefix = this.prefix();
    return this.exclusive(async () => {
      const client = await app().db.pool.connect();
      try {
        // 导出在一个事务里完成：多表拿到同一个快照，不会出现「A 表是新的、B 表是旧的」撕裂备份
        await client.query('BEGIN');
        let archive: BackupArchive;
        try {
          archive = await dumpArchive(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        const body = encodeArchive(archive);
        const now = new Date();
        const key = backupKey(prefix, archive.database, now);
        await this.client().putBackup(key, body);
        const tableCount = archive.tables.length;
        const rowCount = archive.tables.reduce((sum, table) => sum + table.rowCount, 0);
        await this.audit(operatorUserId, 'backup.create', key, reason, { size: body.length, tableCount, rowCount });
        return { key, size: body.length, createdAt: now.toISOString(), tableCount, rowCount };
      } finally {
        client.release();
      }
    });
  }

  /**
   * 从对象存储还原数据库。
   *
   * 还原会覆盖当前数据库全部业务数据：期间阻塞业务写入。
   * 审计写在还原提交之后——还原会 TRUNCATE public schema，audit_logs 也在里面，
   * 写在前面会被自己抹掉。
   */
  async restore(operatorUserId: string | null, key: string, reason: string): Promise<BackupRestoreResponse> {
    if (!this.status().configured) throw new DomainError('BACKUP_NOT_CONFIGURED', '未接入对象存储，无法还原备份');
    return this.exclusive(async () => {
      this.assertInPrefix(this.prefix(), key);
      const body = await this.client().getBackup(key);
      const archive = decodeArchive(body);
      const client = await app().db.pool.connect();
      try {
        const result = await restoreArchive(client, archive);
        await this.audit(operatorUserId, 'backup.restore', key, reason, {
          tableCount: result.tableCount,
          rowCount: result.rowCount,
        });
        return {
          key,
          tableCount: result.tableCount,
          rowCount: result.rowCount,
          restoredAt: new Date().toISOString(),
        };
      } finally {
        client.release();
      }
    });
  }

  /** 删除备份文件。 */
  async remove(operatorUserId: string | null, key: string, reason: string): Promise<void> {
    if (!this.status().configured) throw new DomainError('BACKUP_NOT_CONFIGURED', '未接入对象存储，无法删除备份');
    return this.exclusive(async () => {
      this.assertInPrefix(this.prefix(), key);
      await this.client().deleteBackup(key);
      await this.audit(operatorUserId, 'backup.delete', key, reason, { key });
    });
  }

  /** 下载备份文件本体（后台「下载备份」用）。 */
  async download(key: string): Promise<Buffer> {
    if (!this.status().configured) throw new DomainError('BACKUP_NOT_CONFIGURED', '未接入对象存储，无法下载备份');
    this.assertInPrefix(this.prefix(), key);
    return this.client().getBackup(key);
  }

  /**
   * 定时备份：BACKUP_INTERVAL_HOURS > 0 时按间隔自动做一次。
   * 启动后先等一个间隔再跑（不在启动瞬间打桶），失败只记日志、不影响进程。
   */
  startScheduledBackups(): void {
    const hours = app().env?.BACKUP_INTERVAL_HOURS ?? 0;
    if (hours <= 0) return;
    if (!this.status().configured) {
      this.logger.warn('未接入对象存储，自动备份未启动');
      return;
    }
    this.timer = setInterval(() => void this.runScheduledBackup(), hours * 3_600_000);
    this.timer.unref();
    this.logger.log(`自动备份已启动：每 ${hours} 小时一次`);
  }

  stopScheduledBackups(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runScheduledBackup(): Promise<void> {
    try {
      const result = await this.create(null, '定时自动备份');
      this.logger.log(`自动备份完成：${result.key}（${result.tableCount} 张表 / ${result.rowCount} 行）`);
    } catch (error) {
      this.logger.error('自动备份失败', error instanceof Error ? error.stack : String(error));
    }
  }

  /** 独占执行：已有任务在跑就拒绝，避免备份与还原互相踩。 */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (running) throw new DomainError('BACKUP_IN_PROGRESS', '已有备份任务在执行，请稍后再试');
    running = true;
    try {
      return await fn();
    } finally {
      running = false;
    }
  }

  /** 审计：操作留痕（docs/rebuild/03-SPEC.md §5.2）。 */
  private async audit(
    operatorUserId: string | null,
    action: string,
    objectId: string,
    reason: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    const values = {
      operatorUserId,
      action,
      objectType: 'backup',
      objectId,
      reason,
      afterSummary: after,
    };
    try {
      await app().db.db.insert(auditLogs).values(values);
    } catch (error) {
      // 还原后操作人账号可能不在归档里（外键指向 user.id）：降级成匿名留痕，
      // 不让已经成功的还原因为审计写入失败而报错。
      if (!operatorUserId) throw error;
      this.logger.warn(`审计写入失败（操作人 ${operatorUserId} 不在库中），改为匿名留痕：${action} ${objectId}`);
      await app().db.db.insert(auditLogs).values({ ...values, operatorUserId: null });
    }
  }

  /**
   * 只能操作备份前缀下的、且形状是本系统归档的对象。
   *
   * 前缀挡的是「越界读写桶里其它东西」（1Panel 的备份、别的项目的对象）；
   * key 形状挡的是「前缀下同名的外来文件」——只靠前缀的话，
   * 直接调 API 传个 key 就能让后台还原 / 删除一个根本不是数据库快照的文件。
   */
  private assertInPrefix(prefix: string, key: string): void {
    if (!key.startsWith(prefix) || !isBackupArchiveKey(key)) {
      throw new DomainError('BACKUP_NOT_FOUND', '备份对象不存在');
    }
  }

  /** 备份文件在桶内的前缀：来自 S3_BACKUP_PREFIX，未接入时不存在。 */
  private prefix(): string {
    const prefix = app().env?.S3_BACKUP_PREFIX;
    if (!prefix) throw new DomainError('BACKUP_NOT_CONFIGURED', '未接入对象存储，无法执行备份操作');
    return prefix;
  }

  /** 对象存储客户端：未接入时直接拒绝。 */
  private client(): BackupStorage {
    const options = this.storageOptions();
    if (!options) throw new DomainError('BACKUP_NOT_CONFIGURED', '未接入对象存储，无法执行备份操作');
    if (!this.storage) this.storage = new BackupStorage(options);
    return this.storage;
  }

  /**
   * 对象存储接入参数。
   *
   * 值全部来自环境变量，代码里不留默认值：配了 S3_BUCKET 就必须把整套参数配齐，
   * 缺项在 env.ts 的跨字段校验里已经让进程启动失败，这里不再兜底。
   */
  private storageOptions(): BackupStorageOptions | null {
    const env = app().env;
    const bucket = env?.S3_BUCKET;
    const region = env?.S3_REGION;
    if (!bucket || !region) return null;
    return {
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      region,
      bucket,
      ...(env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID } : {}),
      ...(env.S3_SECRET_ACCESS_KEY ? { secretAccessKey: env.S3_SECRET_ACCESS_KEY } : {}),
      ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    };
  }
}
