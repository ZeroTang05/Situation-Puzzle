/**
 * 对象存储（S3 兼容）：备份文件的存取都在这里，API 层不直接碰 SDK。
 *
 * 凭据只从环境变量读，不落库、不进日志。
 * 未配置 S3_BUCKET 时不创建 client（功能整体降级为「未接入」）。
 */
import { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type ListObjectsV2CommandOutput,
  type PutObjectCommandOutput,
  type DeleteObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { DomainError } from '@jev/domain';

export interface BackupStorageOptions {
  /** 兼容 S3 的服务地址（MinIO / 阿里云 OSS 等）；缺省走 AWS 官方 endpoint */
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  /** 临时凭据（STS）的会话令牌 */
  sessionToken?: string | undefined;
  /** 自建服务通常要 path style 寻址 */
  forcePathStyle: boolean;
}

export interface BackupObjectMeta {
  key: string;
  size: number;
  lastModified: string;
}

/** 备份归档的文件后缀：列表与还原都只认这个后缀，别的文件不进后台。 */
export const BACKUP_FILE_SUFFIX = '.json.gz';

/** 备份归档的 key 形状：`<前缀><yyyymmdd'T'HHMMSS'Z'>-<库名>.json.gz`（UTC，文件名安全）。 */
const BACKUP_KEY_PATTERN = /^\d{8}T\d{6}Z-[A-Za-z0-9_-]+\.json\.gz$/;

/** 备份对象的 key：`<prefix><yyyymmdd'T'HHMMSS'Z'>-<库名>.json.gz`（UTC，文件名安全）。 */
export function backupKey(prefix: string, database: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const safeDatabase = database.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${prefix}${stamp}-${safeDatabase}${BACKUP_FILE_SUFFIX}`;
}

/** key 是不是本系统生成的备份归档：形状与 backupKey 一致才算。 */
export function isBackupArchiveKey(key: string): boolean {
  return BACKUP_KEY_PATTERN.test(key.slice(key.lastIndexOf('/') + 1));
}

/** 从 key 解析备份生成时间：解析不出返回 null，由调用方回落到最后修改时间。 */
export function createdAtFromKey(key: string): string | null {
  const matched = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(key);
  if (!matched) return null;
  const [, year, month, day, hour, minute, second] = matched;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export class BackupStorage {
  private readonly logger = new Logger(BackupStorage.name);
  private readonly client: S3Client;

  constructor(private readonly options: BackupStorageOptions) {
    const credentials =
      options.accessKeyId && options.secretAccessKey
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
          }
        : undefined;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle,
      ...(credentials ? { credentials } : {}),
    });
  }

  async putBackup(key: string, body: Buffer): Promise<void> {
    await this.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
      }),
    );
  }

  async getBackup(key: string): Promise<Buffer> {
    const result = await this.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (!result.Body) throw new DomainError('BACKUP_NOT_FOUND', '备份对象不存在');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  /** 列出前缀下的备份对象，按 key 倒序（新的在前）。 */
  async listBackups(prefix: string): Promise<BackupObjectMeta[]> {
    const items: BackupObjectMeta[] = [];
    let token: string | undefined;
    do {
      const result = await this.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
        // 只列真正的备份归档（key 由 backupKey 生成，形状固定）：
        //  ① 目录占位对象（key 以 / 结尾，0 字节）是控制台建的假目录；
        //  ② 前缀下的其它文件（1Panel 自己的备份、别的工具的导出等）不是数据库快照，
        //     列进后台会变成点开就报「备份文件已损坏」的假记录。
        if (!isBackupArchiveKey(object.Key)) continue;
        items.push({
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: (object.LastModified ?? new Date(0)).toISOString(),
        });
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
    return items.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }

  async deleteBackup(key: string): Promise<void> {
    await this.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  /**
   * 统一的对象存储调用：把 SDK 抛出的原生错误转成 DomainError。
   *
   * 不转的话会落到全局兜底分支，接口只回一句「服务器出了点问题」，
   * 真正的原因（桶名非法、凭据无效、桶不存在……）只留在服务端日志里，后台无从判断。
   *
   * 原始错误细节放 params（诊断用），不放 message —— message 是给用户看的稳定文案，
   * 不能把桶名、endpoint 主机名、签名这类内部拓扑信息抖给浏览器。
   *
   * 细节同时写服务端日志：DomainError 在全局过滤器里不落日志，
   * 不在这儿写的话，错误文案里那句「请查看服务端日志」就是空头支票。
   *
   * 用重载而不是一个泛型签名：泛型会把输出类型抹成 ServiceOutputTypes 联合，
   * result.Body / result.Contents 这些就全成了编译错误或 any。
   */
  private async send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  private async send(command: ListObjectsV2Command): Promise<ListObjectsV2CommandOutput>;
  private async send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  private async send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
  private async send(command: GetObjectCommand | ListObjectsV2Command | PutObjectCommand | DeleteObjectCommand): Promise<unknown> {
    try {
      return await this.client.send(command as never);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      const detail = error instanceof Error ? error.message : String(error);
      // 桶整个没了（NoSuchBucket）与「这个对象没了」是两回事：
      // 前者是配置 / 账号问题，要报 BACKUP_FAILED；后者才是对象不存在。
      if (isObjectNotFound(error)) throw new DomainError('BACKUP_NOT_FOUND', '备份对象不存在');
      this.logger.error(`对象存储操作失败（${name}）：${detail}`);
      throw new DomainError('BACKUP_FAILED', '备份操作失败，请查看服务端日志。', { storageError: name, storageMessage: detail });
    }
  }
}

/**
 * 「这个对象不存在」：只认对象级的错误名。
 *
 * 不能按 404 状态码一刀切——NoSuchBucket（桶被改名 / 删了 / 账号不对）也是 404，
 * 但那是配置问题，报 BACKUP_NOT_FOUND 会让管理员以为只是少了一个文件。
 */
function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate.name === 'NoSuchKey' || candidate.name === 'NotFound') return true;
  return candidate.$metadata?.httpStatusCode === 404 && candidate.name !== 'NoSuchBucket';
}
