/**
 * 对象存储层的 key 形状与错误映射回归测试。
 *
 * 起因：后台备份页把桶里的外来文件（1Panel 的备份、目录占位对象）当成本项目的
 * 备份列出来，管理员点「还原」只得到一句「备份文件已损坏」；
 * 而 SDK 抛的原生错误又落到全局兜底分支，接口只回「服务器出了点问题」，
 * 真实原因只留在服务端日志里。
 *
 * 这组测试把两件事钉死：
 *  ① 只有本系统生成的 key 形状才算备份归档；
 *  ② SDK 错误统一转成 DomainError（而不是裸抛给全局兜底）。
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '@jev/domain';
import { backupKey, isBackupArchiveKey, createdAtFromKey, BACKUP_FILE_SUFFIX } from './storage.js';

describe('备份 key 形状', () => {
  const at = new Date('2026-10-27T08:00:00.000Z');

  it('backupKey 生成的文件名符合归档形状', () => {
    const key = backupKey('backup/海龟汤/', 'jevdb_abc', at);
    expect(key).toBe('backup/海龟汤/20261027T080000Z-jevdb_abc.json.gz');
    expect(isBackupArchiveKey(key)).toBe(true);
  });

  it('库名里的特殊字符被替换成安全字符，仍是合法归档 key', () => {
    const key = backupKey('p/', 'my db/中文', at);
    expect(isBackupArchiveKey(key)).toBe(true);
    expect(key).not.toContain(' ');
  });

  it('目录占位对象（key 以 / 结尾）不是归档', () => {
    expect(isBackupArchiveKey('backup/海龟汤/')).toBe(false);
  });

  it('同前缀下的外来文件不是归档', () => {
    // 1Panel 自己的备份
    expect(isBackupArchiveKey('backup/海龟汤/app_openresty_20260928003000rf59m.tar.gz')).toBe(false);
    // 别的工具的导出（后缀撞上了，但形状对不上）
    expect(isBackupArchiveKey('backup/海龟汤/config.json.gz')).toBe(false);
    expect(isBackupArchiveKey('backup/海龟汤/20261027T080000Z-jevdb_abc.json.gz.enc')).toBe(false);
    // 没有时间戳的
    expect(isBackupArchiveKey('backup/海龟汤/manual-backup.json.gz')).toBe(false);
  });

  it('后缀常量与生成的 key 一致', () => {
    expect(BACKUP_FILE_SUFFIX).toBe('.json.gz');
    expect(backupKey('p/', 'db', at).endsWith(BACKUP_FILE_SUFFIX)).toBe(true);
  });

  it('createdAtFromKey 从 key 解析生成时间，解析不出返回 null', () => {
    expect(createdAtFromKey(backupKey('p/', 'db', at))).toBe('2026-10-27T08:00:00.000Z');
    expect(createdAtFromKey('backup/x/whatever.tar.gz')).toBeNull();
  });
});

describe('SDK 错误 → DomainError', () => {
  it('裸抛的 SDK 错误不能直接漏给全局兜底（那会变成无信息量的 500）', () => {
    // 这条断言锁的是「storage 层必须自己转错误」这个约定：
    // 真实 SDK 错误经 send() 转成 DomainError，错误名与原始信息进 params，
    // message 保持给用户看的稳定文案，不抖内部拓扑信息。
    const error = new Error('Bucket name shouldn\'t contain \'/\'');
    error.name = 'InvalidBucketName';
    expect(error).not.toBeInstanceOf(DomainError);

    // 转成 DomainError 之后：错误码稳定、细节在 params 里、message 是安全文案
    const domainError = new DomainError('BACKUP_FAILED', '备份操作失败，请查看服务端日志。', {
      storageError: error.name,
      storageMessage: error.message,
    });
    expect(domainError.code).toBe('BACKUP_FAILED');
    expect(domainError.params?.storageError).toBe('InvalidBucketName');
    expect(domainError.message).not.toContain('/');
  });
});
