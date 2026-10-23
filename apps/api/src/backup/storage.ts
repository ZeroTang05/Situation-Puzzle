/**
 * 对象存储（S3 兼容）：备份文件的存取都在这里，API 层不直接碰 SDK。
 *
 * 凭据只从环境变量读，不落库、不进日志。
 * 未配置 S3_BUCKET 时不创建 client（功能整体降级为「未接入」）。
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
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
  /** 备份文件在桶内的前缀 */
  prefix: string;
}

export interface BackupObjectMeta {
  key: string;
  size: number;
  lastModified: string;
}

/** 备份对象的 key：`<prefix><yyyymmdd'T'HHMMSS'Z'>-<库名>.json.gz`（UTC，文件名安全）。 */
export function backupKey(prefix: string, database: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const safeDatabase = database.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${prefix}${stamp}-${safeDatabase}.json.gz`;
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
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
      }),
    );
  }

  async getBackup(key: string): Promise<Buffer> {
    let result;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) throw new DomainError('BACKUP_NOT_FOUND', '备份对象不存在');
      throw error;
    }
    if (!result.Body) throw new DomainError('BACKUP_NOT_FOUND', '备份对象不存在');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  /** 列出前缀下的备份对象，按 key 倒序（新的在前）。 */
  async listBackups(prefix: string): Promise<BackupObjectMeta[]> {
    const items: BackupObjectMeta[] = [];
    let token: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
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
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}

/** 对象不存在：S3 各家错误名不统一，按错误名与状态码一起判。 */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate.name === 'NoSuchKey' || candidate.name === 'NotFound') return true;
  return candidate.$metadata?.httpStatusCode === 404;
}
